'use strict';

/**
 * magicEdenResolver.js — Magic Eden launchpad/collection resolver.
 *
 * ROLE OF A RESOLVER (deliberately narrow)
 * ----------------------------------------
 * A resolver answers exactly one question: "which contract, on which chain?"
 *
 * It does NOT decide the mint price or the start time. Those come from
 * src/chains/evm/mintStage.js, which reads them off the contract itself. That
 * split is the whole reason this file can be implemented safely without having a
 * captured API response to hand: slug->contract mapping is a stable, verifiable
 * thing, whereas price/time field names and units are not.
 *
 * If the API does happen to return price/time we pass them through as `apiHints`
 * for display only, clearly labelled, and the on-chain read always wins.
 *
 * Magic Eden's EVM API is Reservoir-derived, so the collection endpoint returns
 * `{ collections: [ { id, name, primaryContract, ... } ] }` where `id` is the
 * contract address. Solana uses a different, non-Reservoir shape.
 */

const chainMap = require('./chainMap');

const PLATFORM = 'magiceden';

/**
 * URL forms:
 *   https://magiceden.io/launchpad/<chain>/<slug>
 *   https://magiceden.io/collections/<chain>/<slugOrAddress>
 *   https://magiceden.io/marketplace/<slug>            (solana, legacy)
 *   https://magiceden.us/... (regional mirror)
 */
const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?magiceden\.(?:io|us)\/launchpad\/([a-z0-9_-]+)\/([A-Za-z0-9_.-]+)/i,
  /^https?:\/\/(?:www\.)?magiceden\.(?:io|us)\/collections\/([a-z0-9_-]+)\/([A-Za-z0-9_.:-]+)/i,
  /^https?:\/\/(?:www\.)?magiceden\.(?:io|us)\/marketplace\/([A-Za-z0-9_.-]+)/i,
];

function matches(url) {
  return URL_PATTERNS.some((re) => re.test(url));
}

/**
 * @returns {{chainSlug: string, slug: string, isAddress: boolean}|null}
 */
function parseUrl(url) {
  for (const re of URL_PATTERNS.slice(0, 2)) {
    const m = url.match(re);
    if (m) {
      const slug = m[2];
      return {
        chainSlug: m[1].toLowerCase(),
        slug,
        isAddress: /^0x[a-fA-F0-9]{40}$/.test(slug),
      };
    }
  }
  const legacy = url.match(URL_PATTERNS[2]);
  if (legacy) {
    // /marketplace/<slug> with no chain segment is Solana in Magic Eden's
    // original URL scheme.
    return { chainSlug: 'solana', slug: legacy[1], isAddress: false };
  }
  return null;
}

/** GET with timeout + retry on transient status codes. */
async function apiGet(path, { config, logger = console, attempts = 3 }) {
  const base = config?.apiBaseUrl;
  if (!base || /REQUIRED_FILL_ME/.test(base)) {
    const e = new Error('Magic Eden apiBaseUrl is not configured (config/default.json).');
    e.code = 'RESOLVER_NOT_CONFIGURED';
    throw e;
  }

  const url = `${base.replace(/\/$/, '')}${path}`;
  const headers = { Accept: 'application/json' };
  // Magic Eden uses a bearer token; it is optional for public read endpoints but
  // raises the rate limit substantially.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(config.timeoutMs ?? 10000) });

      if (res.status === 401 || res.status === 403) {
        const e = new Error(`Magic Eden API rejected the request (${res.status}) — MAGICEDEN_API_KEY may be required.`);
        e.code = 'RESOLVER_AUTH';
        throw e;
      }
      if (res.status === 404) {
        const e = new Error('Magic Eden API returned 404 — collection not found.');
        e.code = 'RESOLVER_NOT_FOUND';
        throw e;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Magic Eden transient error ${res.status}`);
        const wait = 500 * 2 ** i;
        logger.warn?.(`[magiceden] ${res.status}, retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`Magic Eden API error ${res.status}`);
      return await res.json();
    } catch (err) {
      if (['RESOLVER_AUTH', 'RESOLVER_NOT_FOUND'].includes(err.code)) throw err;
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  const e = new Error(`Magic Eden API unreachable after ${attempts} attempts: ${lastErr?.message}`);
  e.code = 'RESOLVER_UNAVAILABLE';
  throw e;
}

/**
 * Pull the contract address out of a Reservoir-style collections response.
 * Tolerant of the two field names Reservoir has used (`primaryContract`, and
 * `id` which is the address for single-contract collections) but never invents
 * one — an unrecognised body is an explicit error.
 */
function extractContract(body) {
  const coll = Array.isArray(body?.collections) ? body.collections[0] : body?.collection || body;
  if (!coll) return null;

  const candidates = [coll.primaryContract, coll.contract, coll.id, coll.address];
  for (const c of candidates) {
    if (typeof c === 'string') {
      // Reservoir sometimes namespaces ids as "<chain>:<address>" or
      // "<address>:<tokenId>"; take the 0x… component wherever it sits.
      const m = c.match(/0x[a-fA-F0-9]{40}/);
      if (m) return { address: m[0], name: coll.name || null, raw: coll };
    }
  }
  return null;
}

/**
 * Resolve a Magic Eden URL to { chain, contract }.
 *
 * Note the shortcut: when the URL already contains the contract address we skip
 * the API entirely. Fewer moving parts, no rate limit, no auth — and the address
 * in the URL is exactly what the user is looking at.
 */
async function resolve(url, { config = {}, fullConfig = null, logger = console } = {}) {
  const parsed = parseUrl(url);
  if (!parsed) {
    const e = new Error(`not a recognised Magic Eden URL: ${String(url).slice(0, 120)}`);
    e.code = 'RESOLVER_BAD_URL';
    throw e;
  }

  const chain = chainMap.toConfigKey(PLATFORM, parsed.chainSlug, fullConfig);
  if (!chain) throw chainMap.unknownChainError(PLATFORM, parsed.chainSlug, fullConfig);

  const net = fullConfig?.networks?.[chain];
  if (net && net.kind !== 'evm') {
    const e = new Error(
      `This is a ${net.displayName || chain} collection. Automated minting is only implemented for ` +
        `EVM chains — see /help for what is supported.`
    );
    e.code = 'CHAIN_NOT_IMPLEMENTED';
    throw e;
  }

  let address = parsed.isAddress ? parsed.slug : null;
  let collectionName = null;
  let raw = null;

  if (!address) {
    const body = await apiGet(`/collections/${encodeURIComponent(parsed.slug)}/v3`, { config, logger });
    const found = extractContract(body);
    if (!found) {
      const e = new Error(
        `Could not find a contract address in Magic Eden's response for "${parsed.slug}".\n` +
          `Use /manualtarget to supply the chain and contract address directly.`
      );
      e.code = 'RESOLVER_NO_CONTRACT';
      throw e;
    }
    address = found.address;
    collectionName = found.name;
    raw = found.raw;
  }

  return {
    platform: PLATFORM,
    chain,
    kind: 'evm',
    collectionName: collectionName || parsed.slug,
    contractOrProgram: address,
    // Price and start time are intentionally NOT set here — mintStage.js reads
    // them from the contract. Leaving them null forces that path rather than
    // letting an API guess reach the signer.
    mintPrice: null,
    mintStartAt: null,
    maxPerWallet: null,
    totalSupply: null,
    currencySymbol: fullConfig?.networks?.[chain]?.nativeCurrency?.symbol || 'ETH',
    raw,
  };
}

module.exports = { PLATFORM, URL_PATTERNS, apiGet, extractContract, matches, parseUrl, resolve };
