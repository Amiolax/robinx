'use strict';

/**
 * openseaResolver.js — PRIMARY resolver (spec §4).
 *
 * WHAT THIS RESOLVER IS RESPONSIBLE FOR (and what it deliberately is not)
 * ----------------------------------------------------------------------
 * It answers ONE question: which contract, on which chain?
 *
 * It does NOT determine the mint price or the mint start time. The original
 * design did, and that was the wrong call — those values were to be read out of
 * a marketplace JSON body whose field names and units could not be verified,
 * where being wrong means spending real money at the wrong number or the wrong
 * moment, silently.
 *
 * Price and start time are now read from the CONTRACT, by
 * src/chains/evm/mintStage.js, over free eth_calls. The contract is the
 * authority: whatever it reports is exactly what it will enforce at T=0. That
 * removes the guesswork entirely rather than deferring it, and it means this
 * resolver works on any chain OpenSea lists without needing a captured sample
 * per chain.
 *
 * So the risky mapping is gone by design, not postponed. What remains here is
 * slug -> {chain, address}, which is stable and independently verifiable (the
 * address is visible in the OpenSea UI and on the explorer).
 *
 * NORMALISED SHAPE returned by resolve() — shared by every resolver:
 *
 *   {
 *     platform:          'opensea',
 *     chain:             string,        // config.networks key, e.g. 'ethereum'
 *     kind:              'evm',
 *     collectionName:    string,
 *     contractOrProgram: string,        // 0x… contract address
 *     mintPrice:         null,          // filled from chain by mintStage.js
 *     mintStartAt:       null,          // filled from chain by mintStage.js
 *     maxPerWallet:      number|null,
 *     totalSupply:       number|null,
 *     currencySymbol:    string,
 *     raw:               object
 *   }
 *
 * The mint CALL ITSELF does not come from here either: src/chains/evm/erc721Mint.js
 * probes the contract for a working mint()/claim() entrypoint.
 */

const chainMap = require('./chainMap');

const PLATFORM = 'opensea';


/**
 * URL forms. Safe and deterministic — no API involved, so these are fully
 * implemented and usable right now.
 *
 *   https://opensea.io/collection/<slug>
 *   https://opensea.io/collection/<slug>/overview
 *   https://opensea.io/collection/<slug>/drop
 *   https://opensea.io/assets/<chain>/<address>/<tokenId>
 *   https://pro.opensea.io/collection/<slug>
 */
const URL_PATTERNS = [
  /^https?:\/\/(?:www\.|pro\.)?opensea\.io\/collection\/([A-Za-z0-9_-]+)/i,
  /^https?:\/\/(?:www\.)?opensea\.io\/assets\/([A-Za-z0-9_-]+)\/(0x[a-fA-F0-9]{40})(?:\/(\d+))?/i,
];

function matches(url) {
  return URL_PATTERNS.some((re) => re.test(url));
}

/** @returns {{slug}|{chainSlug,address,tokenId}|null} */
function parseUrl(url) {
  const assets = url.match(URL_PATTERNS[1]);
  if (assets) {
    return { chainSlug: assets[1].toLowerCase(), address: assets[2], tokenId: assets[3] || null };
  }
  const coll = url.match(URL_PATTERNS[0]);
  if (coll) return { slug: coll[1] };
  return null;
}

/**
 * HTTP GET with auth header, timeout, and retry on transient failures.
 * Implemented and reusable — independent of whatever the body turns out to be.
 */
async function apiGet(path, { config, logger = console, attempts = 3 }) {
  const base = config?.apiBaseUrl;
  if (!base || /REQUIRED_FILL_ME/.test(base)) {
    const e = new Error(
      'OpenSea apiBaseUrl is not configured (config/default.json -> resolvers.opensea.apiBaseUrl). ' +
        'The correct API host/version for Robinhood Chain listings has not been confirmed.'
    );
    e.code = 'RESOLVER_NOT_CONFIGURED';
    throw e;
  }

  const url = `${base.replace(/\/$/, '')}${path}`;
  const headers = { Accept: 'application/json' };
  if (config.apiKey) headers['X-API-KEY'] = config.apiKey;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(config.timeoutMs ?? 10000),
      });

      if (res.status === 401 || res.status === 403) {
        const e = new Error(
          `OpenSea API rejected the request (${res.status}). An OPENSEA_API_KEY is likely required.`
        );
        e.code = 'RESOLVER_AUTH';
        throw e; // not retryable
      }
      if (res.status === 404) {
        const e = new Error('OpenSea API returned 404 — collection slug not found.');
        e.code = 'RESOLVER_NOT_FOUND';
        throw e; // not retryable
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OpenSea API transient error ${res.status}`);
        const wait = 500 * Math.pow(2, i);
        logger.warn?.(`[opensea] ${res.status}, retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`OpenSea API error ${res.status}`);

      return await res.json();
    } catch (err) {
      if (['RESOLVER_AUTH', 'RESOLVER_NOT_FOUND'].includes(err.code)) throw err;
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  const e = new Error(`OpenSea API unreachable after ${attempts} attempts: ${lastErr?.message}`);
  e.code = 'RESOLVER_UNAVAILABLE';
  throw e;
}

/**
 * Map an OpenSea v2 collection body to { chain, contract, name }.
 *
 * SCOPE NOTE — this is the function that used to refuse to run. It is now safe
 * to implement because its job shrank: it no longer reads price or start time
 * (those come from the contract via mintStage.js), so the dangerous, unverifiable
 * parts of the old mapping simply do not exist anymore.
 *
 * What's left is the `contracts: [{address, chain}]` array, which is:
 *   - documented and stable across OpenSea's v2 API,
 *   - independently checkable (the address shows in the UI and on the explorer),
 *   - and validated downstream: getCode() must return bytecode, and the mint
 *     probe must find a callable entrypoint, before anything is signed.
 *
 * Multi-chain collections are resolved by chainMap.pickContract(), which refuses
 * to pick arbitrarily rather than defaulting to contracts[0].
 */
function mapResponse(body, { parsed, fullConfig } = {}) {
  const coll = body?.collection ? body.collection : body;
  if (!coll || typeof coll !== 'object') {
    const e = new Error('OpenSea returned an unrecognised response body (no collection object).');
    e.code = 'RESOLVER_INVALID_DATA';
    throw e;
  }

  // The /chain/<c>/contract/<a> endpoint already pins both values, so trust the
  // URL over the body there — it's what the user is actually looking at.
  let address = parsed?.address || null;
  let chainSlug = parsed?.chainSlug || null;

  if (!address) {
    const contracts = Array.isArray(coll.contracts)
      ? coll.contracts
      : coll.contract
        ? [{ address: coll.contract, chain: coll.chain || chainSlug }]
        : [];

    const picked = chainMap.pickContract(PLATFORM, contracts, fullConfig, {
      preferChain: chainSlug ? chainMap.toConfigKey(PLATFORM, chainSlug, fullConfig) : null,
    });
    address = picked.address;
    chainSlug = picked.chain;
  }

  const chain = chainMap.toConfigKey(PLATFORM, chainSlug, fullConfig);
  if (!chain) throw chainMap.unknownChainError(PLATFORM, chainSlug, fullConfig);

  // Read `kind` from config rather than assuming 'evm'. OpenSea lists non-EVM
  // chains (Solana) too, and hardcoding 'evm' would let a Solana collection
  // through as if it were mintable — the executor would then be handed an
  // address it cannot sign for. resolve() rejects those explicitly below.
  const kind = fullConfig?.networks?.[chain]?.kind || 'evm';

  return {
    platform: PLATFORM,
    chain,
    kind,

    collectionName: coll.name || coll.slug || parsed?.slug || address,
    contractOrProgram: address,
    // Read on-chain at target-creation time — see mintStage.js.
    mintPrice: null,
    mintStartAt: null,
    maxPerWallet: null,
    totalSupply: Number.isFinite(coll.total_supply) ? coll.total_supply : null,
    currencySymbol: fullConfig?.networks?.[chain]?.nativeCurrency?.symbol || 'ETH',
    raw: { slug: coll.slug ?? null, name: coll.name ?? null, chain: chainSlug },
  };
}

/**
 * Sanity checks before a resolved target is used.
 *
 * mintPrice/mintStartAt are now allowed to be null here — they are populated
 * later from the contract, and the wizard refuses to arm without them. The
 * price-plausibility and seconds-vs-millis guards are retained because they
 * still apply to whatever ends up being persisted, whatever its source.
 */
function validateNormalised(t, { config } = {}) {
  const problems = [];

  if (!t.contractOrProgram || !/^0x[a-fA-F0-9]{40}$/.test(t.contractOrProgram)) {
    problems.push(`contract address is not a valid 0x address: ${t.contractOrProgram}`);
  }
  if (t.mintPrice !== null && t.mintPrice !== undefined) {
    if (typeof t.mintPrice !== 'bigint' || t.mintPrice < 0n) {
      problems.push('mintPrice must be a non-negative BigInt (wei) or null');
    } else if (t.mintPrice > 100n * 10n ** 18n) {
      // 100 ETH for a mint is far more likely a units bug (ETH read as wei)
      // than a real price. Refuse rather than let it through.
      problems.push(
        `mintPrice ${t.mintPrice} wei (>100 ETH) is implausible — likely a unit conversion bug`
      );
    }
  }
  if (t.mintStartAt !== null && t.mintStartAt !== undefined) {
    if (!Number.isFinite(t.mintStartAt)) problems.push('mintStartAt must be epoch ms or null');
    // Catch the classic seconds-vs-millis mistake: anything before 2001 in ms.
    else if (t.mintStartAt > 0 && t.mintStartAt < 1_000_000_000_000) {
      problems.push(
        `mintStartAt ${t.mintStartAt} looks like epoch SECONDS, not milliseconds — off by ~1000x`
      );
    }
  }
  if (!t.chain || (config && !config.networks?.[t.chain])) {
    problems.push(`chain "${t.chain}" is not a known network key in config/default.json`);
  }

  if (problems.length) {
    const e = new Error(`OpenSea resolver produced invalid data:\n  - ${problems.join('\n  - ')}`);
    e.code = 'RESOLVER_INVALID_DATA';
    throw e;
  }
  return t;
}

/**
 * Resolve an OpenSea URL to a normalised target.
 *
 * Fast path: an /assets/<chain>/<address> URL already contains everything we
 * need, so we skip the API entirely — no key required, no rate limit, nothing to
 * be stale. That also means this resolver keeps working for asset links even
 * when OPENSEA_API_KEY is absent.
 */
async function resolve(url, { config = {}, fullConfig = null, logger = console } = {}) {
  const parsed = parseUrl(url);
  if (!parsed) {
    const e = new Error(`not a recognised OpenSea URL: ${String(url).slice(0, 120)}`);
    e.code = 'RESOLVER_BAD_URL';
    throw e;
  }

  const normalised = parsed.address
    ? mapResponse({}, { parsed, fullConfig })
    : mapResponse(await apiGet(`/collections/${parsed.slug}`, { config, logger }), {
        parsed,
        fullConfig,
      });

  // Chain resolved, but this bot can only SIGN on EVM. Say so in those terms —
  // otherwise validateNormalised() rejects the (perfectly valid) non-0x address
  // as "invalid data", which reads like a bug on our side rather than a
  // capability limit.
  if (normalised.kind !== 'evm') {
    const net = fullConfig?.networks?.[normalised.chain];
    const e = new Error(
      `That OpenSea collection is on ${net?.displayName || normalised.chain}, which this bot ` +
        `cannot mint on automatically — only EVM chains are wired for minting. ` +
        `Deposits, balances and withdrawals still work there. See /help.`
    );
    e.code = 'CHAIN_NOT_IMPLEMENTED';
    throw e;
  }

  return validateNormalised(normalised, { config: fullConfig });
}



module.exports = {
  PLATFORM,
  URL_PATTERNS,
  apiGet,
  mapResponse,
  matches,
  parseUrl,
  resolve,
  validateNormalised,
};
