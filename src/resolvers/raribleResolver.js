'use strict';

/**
 * raribleResolver.js — Rarible link -> (chain, contract address).
 *
 * SCOPE, AND WHY IT IS THIS NARROW
 * --------------------------------
 * This module answers exactly one question: "which contract, on which chain?"
 * It deliberately does NOT return a mint price or a start time, even though
 * Rarible's API will happily hand over a floor / bestSellOrder price.
 *
 * Those two numbers look alike and mean different things. A marketplace price is
 * what someone asks for an EXISTING token on the secondary market. A mint price
 * is what the contract's mint function requires as msg.value. Substituting one
 * for the other either reverts (gas burned) or overpays. So price and timing are
 * always read from the contract — see src/chains/evm/mintStage.js.
 *
 * Rarible's id format is the other thing worth knowing: the protocol API
 * namespaces ids as "BLOCKCHAIN:0xaddress" (e.g. "ETHEREUM:0x1234..."). That
 * prefix is load-bearing — it is how we know which chain a collection is on —
 * so it is parsed, never stripped blindly.
 */

const chainMap = require('./chainMap');

const PLATFORM = 'rarible';

/**
 * URL forms Rarible uses:
 *   /collection/<chain>/<addressOrSlug>
 *   /token/<chain>/<address>:<tokenId>
 *   /collection/<addressOrSlug>          (legacy, chain omitted)
 *   /token/<address>:<tokenId>           (legacy)
 *   /<slug>/items                        (vanity collection page)
 */
const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?rarible\.com\/collection\/([a-zA-Z]+)\/([A-Za-z0-9_.:-]+)/i,
  /^https?:\/\/(?:www\.)?rarible\.com\/token\/([a-zA-Z]+)\/([A-Za-z0-9_.:-]+)/i,
  /^https?:\/\/(?:www\.)?rarible\.com\/collection\/([A-Za-z0-9_.:-]+)/i,
  /^https?:\/\/(?:www\.)?rarible\.com\/token\/([A-Za-z0-9_.:-]+)/i,
  /^https?:\/\/(?:www\.)?rarible\.com\/([A-Za-z0-9_-]+)\/items/i,
];

function matches(url) {
  return URL_PATTERNS.some((re) => re.test(url));
}

/**
 * @returns {{chainSlug: string|null, ref: string, isAddress: boolean}|null}
 *
 * chainSlug is null for the legacy/vanity forms that omit it. That is reported
 * honestly rather than defaulted to ethereum: defaulting is how a Polygon
 * collection resolves to a mainnet address that may belong to someone else.
 */
function parseUrl(url) {
  const s = String(url || '');

  // Chain-qualified forms first — they carry the most information.
  for (const re of URL_PATTERNS.slice(0, 2)) {
    const m = s.match(re);
    if (m) {
      const ref = m[2];
      const addr = ref.match(/0x[a-fA-F0-9]{40}/);
      return { chainSlug: m[1].toLowerCase(), ref: addr ? addr[0] : ref, isAddress: Boolean(addr) };
    }
  }

  // Unqualified forms: the id may still be namespaced as "ETHEREUM:0x...".
  for (const re of URL_PATTERNS.slice(2)) {
    const m = s.match(re);
    if (m) {
      const ref = m[1];
      const ns = ref.match(/^([A-Za-z]+):(0x[a-fA-F0-9]{40})/);
      if (ns) return { chainSlug: ns[1].toLowerCase(), ref: ns[2], isAddress: true };
      const addr = ref.match(/0x[a-fA-F0-9]{40}/);
      return { chainSlug: null, ref: addr ? addr[0] : ref, isAddress: Boolean(addr) };
    }
  }
  return null;
}

/**
 * GET a Rarible API path.
 *
 * Retries transport/5xx only. A 404 or an auth failure is never retried: the
 * collection genuinely isn't there, or the key is genuinely wrong, and hammering
 * the endpoint during a drop only gets us rate-limited when we need it most.
 */
async function apiGet(path, { config, logger = console, attempts = 3 }) {
  const base = config?.apiBaseUrl;
  if (!base || /REQUIRED_FILL_ME/.test(base)) {
    const e = new Error('Rarible apiBaseUrl is not configured (config/default.json).');
    e.code = 'RESOLVER_NOT_CONFIGURED';
    throw e;
  }

  const url = `${base.replace(/\/$/, '')}${path}`;
  const headers = { Accept: 'application/json' };
  if (config.apiKey) headers['X-API-KEY'] = config.apiKey;

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(config.timeoutMs ?? 10000) });

      if (res.status === 401 || res.status === 403) {
        const e = new Error('Rarible rejected the request (check RARIBLE_API_KEY).');
        e.code = 'RESOLVER_AUTH';
        throw e;
      }
      if (res.status === 404) {
        const e = new Error('Rarible has no such collection.');
        e.code = 'RESOLVER_NOT_FOUND';
        throw e;
      }
      if (res.status === 429) {
        const e = new Error('Rarible rate limit hit.');
        e.code = 'RESOLVER_UNAVAILABLE';
        throw e;
      }
      if (!res.ok) throw new Error(`Rarible HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (['RESOLVER_AUTH', 'RESOLVER_NOT_FOUND', 'RESOLVER_NOT_CONFIGURED'].includes(err.code)) throw err;
      lastErr = err;
      // Linear, not exponential: a drop window is short, and a long backoff
      // resolves the link after the mint has already sold out.
      if (i < attempts) await new Promise((r) => setTimeout(r, 300 * i));
    }
  }

  const e = new Error(`Rarible API unreachable: ${lastErr?.message || 'unknown error'}`);
  e.code = 'RESOLVER_UNAVAILABLE';
  throw e;
}

/** Pull a 0x address out of a body, handling both bare and "CHAIN:0x..." ids. */
function extractContract(body) {
  for (const c of [body?.id, body?.address, body?.contract, body?.collection?.id]) {
    if (typeof c === 'string') {
      const m = c.match(/0x[a-fA-F0-9]{40}/);
      if (m) return m[0];
    }
  }
  return null;
}

/** Read the blockchain name off a body or a namespaced id. */
function extractChainSlug(body) {
  if (typeof body?.blockchain === 'string') return body.blockchain.toLowerCase();
  if (typeof body?.id === 'string' && body.id.includes(':')) return body.id.split(':')[0].toLowerCase();
  return null;
}

/**
 * @returns {{platform, chain, kind, collectionName, contractOrProgram, sourceUrl, raw}}
 *
 * Note what is absent: no mintPrice, no mintStartAt. src/resolvers/index.js
 * reads those from the contract afterwards.
 */
async function resolve(url, { config = {}, fullConfig = null, logger = console } = {}) {
  const parsed = parseUrl(url);
  if (!parsed) {
    const e = new Error(`not a recognised Rarible URL: ${String(url).slice(0, 120)}`);
    e.code = 'RESOLVER_BAD_URL';
    throw e;
  }

  let chainSlug = parsed.chainSlug;
  let contract = parsed.isAddress ? parsed.ref : null;
  let name = null;
  let raw = null;

  // If the URL already gave us chain AND address, skip the API entirely: fewer
  // moving parts during a drop, and it still works if Rarible is rate-limiting.
  if (!contract || !chainSlug) {
    const prefix = chainSlug ? chainSlug.toUpperCase() : 'ETHEREUM';
    const id = parsed.isAddress ? `${prefix}:${parsed.ref}` : parsed.ref;
    const body = await apiGet(`/collections/${encodeURIComponent(id)}`, { config, logger });
    raw = body;
    contract = contract || extractContract(body);
    chainSlug = chainSlug || extractChainSlug(body);
    name = body?.name || body?.meta?.name || null;
  }

  if (!contract) {
    const e = new Error(
      'Rarible did not return a contract address for that link. Use ' +
        '/manualtarget <network> <contract> if you know the address.'
    );
    e.code = 'RESOLVER_NO_CONTRACT';
    throw e;
  }

  if (!chainSlug) {
    const e = new Error(
      'Could not determine which chain that Rarible link refers to. Use a ' +
        'chain-qualified link (rarible.com/collection/<chain>/<address>) or ' +
        '/manualtarget <network> <contract>.'
    );
    e.code = 'RESOLVER_UNKNOWN_CHAIN';
    throw e;
  }

  const chain = chainMap.toConfigKey(PLATFORM, chainSlug, fullConfig);
  if (!chain) throw chainMap.unknownChainError(PLATFORM, chainSlug, fullConfig);

  const net = fullConfig?.networks?.[chain];
  if (net && net.kind !== 'evm') {
    const e = new Error(
      `That Rarible collection is on ${chainSlug}, which this bot cannot mint on ` +
        `automatically (only EVM chains are supported).`
    );
    e.code = 'CHAIN_NOT_IMPLEMENTED';
    throw e;
  }

  return {
    platform: PLATFORM,
    chain,
    kind: 'evm',
    collectionName: name || `rarible:${contract.slice(0, 10)}...`,
    contractOrProgram: contract,
    sourceUrl: url,
    raw: raw ? { id: raw.id ?? null, name: raw.name ?? null, blockchain: chainSlug } : null,
  };
}

module.exports = {
  PLATFORM,
  URL_PATTERNS,
  apiGet,
  extractChainSlug,
  extractContract,
  matches,
  parseUrl,
  resolve,
};
