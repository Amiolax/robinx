'use strict';

/**
 * openseaResolver.js — PRIMARY resolver (spec §4). OpenSea -> Robinhood Chain.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: transport + URL parsing + validation are DONE and tested-shaped.  │
 * │         The FIELD MAPPING (mapResponse) is INTENTIONALLY UNIMPLEMENTED.   │
 * │                                                                           │
 * │ I have not seen a real OpenSea API response for a Robinhood Chain drop,   │
 * │ so I will not invent one. Guessing field names here is uniquely dangerous:│
 * │ a wrong `mint_price` or a misread timezone on `mint_start_at` spends real │
 * │ money at the wrong number or at the wrong moment, and it fails SILENTLY   │
 * │ (the code "works", the values are just wrong).                            │
 * │                                                                           │
 * │ TO FINISH THIS FILE: paste one real response into __fixtures__/ and fill  │
 * │ in mapResponse(). Nothing else in the file should need to change.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * NORMALISED SHAPE returned by resolve() — shared by every resolver:
 *
 *   {
 *     platform:          'opensea',
 *     chain:             string,        // config.networks key, e.g. 'robinhood'
 *     kind:              'evm',
 *     collectionName:    string,
 *     contractOrProgram: string,        // 0x… contract address
 *     mintPrice:         BigInt,        // WEI per unit
 *     mintStartAt:       number|null,   // epoch ms UTC
 *     maxPerWallet:      number|null,
 *     totalSupply:       number|null,
 *     currencySymbol:    string,
 *     raw:               object
 *   }
 *
 * The mint CALL ITSELF does not come from here: src/chains/evm/erc721Mint.js
 * probes the contract for a working mint()/claim() entrypoint. This resolver only
 * has to produce a correct contract address, price, and start time.
 */

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
 * ###########################################################################
 * ## THE ONE UNIMPLEMENTED FUNCTION. Fill this in from a real response.    ##
 * ###########################################################################
 *
 * Map OpenSea's JSON onto the normalised shape above.
 *
 * WHAT I NEED FROM THE REAL RESPONSE TO WRITE THIS CORRECTLY:
 *
 *  1. CONTRACT ADDRESS — which field, and where. On the v2 collection endpoint
 *     it's historically `contracts: [{address, chain}]` (an ARRAY — a collection
 *     can span chains, so we must pick the entry whose `chain` is Robinhood
 *     Chain, not blindly take [0]). Need to confirm this holds here.
 *
 *  2. THE CHAIN SLUG OpenSea uses for Robinhood Chain. This is a hard blocker:
 *     it's how we (a) pick the right contract from that array and (b) map to our
 *     config.networks key. It is NOT guessable — could be 'robinhood',
 *     'robinhood-chain', 'rhc', or something unrelated.
 *
 *  3. MINT PRICE — field, and CRUCIALLY the units. Wei string? Decimal ETH
 *     float? A nested {value, currency, decimals}? A float here silently loses
 *     precision; I will parse to BigInt wei with string math, but I have to know
 *     the input units to do that safely.
 *
 *  4. MINT START TIME — field and format. ISO8601 with offset? Unix seconds?
 *     Unix millis? Naive local time? A seconds/millis mixup misfires the snipe by
 *     ~55 years; a missing timezone misfires it by hours.
 *
 *  5. STAGES — do drops expose separate presale/allowlist vs public stages? If
 *     so we must target the PUBLIC stage's start time, or we'll fire at the
 *     allowlist opening and revert (not allowlisted) every time.
 *
 * Until this is filled in, resolve() refuses to return a target.
 */
function mapResponse(/* body, { parsed, config } */) {
  const e = new Error(
    'OpenSea response mapping is not implemented — no real Robinhood Chain response has been provided.\n' +
      'Refusing to guess at field names for contract address / mint price / mint start time: ' +
      'a wrong value here spends real funds at the wrong price or the wrong time, and fails silently.\n' +
      'Fix: paste one real OpenSea API response for a Robinhood Chain drop, then implement ' +
      'mapResponse() in src/resolvers/openseaResolver.js.'
  );
  e.code = 'RESOLVER_MAPPING_UNIMPLEMENTED';
  throw e;
}

/**
 * Post-mapping sanity checks. Implemented now so that the moment mapResponse()
 * is filled in, bad data still can't reach the scheduler.
 *
 * These catch the exact failure modes that make a wrong mapping expensive.
 */
function validateNormalised(t, { config } = {}) {
  const problems = [];

  if (!t.contractOrProgram || !/^0x[a-fA-F0-9]{40}$/.test(t.contractOrProgram)) {
    problems.push(`contract address is not a valid 0x address: ${t.contractOrProgram}`);
  }
  if (typeof t.mintPrice !== 'bigint' || t.mintPrice < 0n) {
    problems.push('mintPrice must be a non-negative BigInt (wei)');
  }
  // 100 ETH for a mint is far more likely a units bug (ETH read as wei) than a
  // real price. Refuse rather than let it through.
  if (typeof t.mintPrice === 'bigint' && t.mintPrice > 100n * 10n ** 18n) {
    problems.push(
      `mintPrice ${t.mintPrice} wei (>100 ETH) is implausible — likely a unit conversion bug`
    );
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
 * Wired end-to-end except mapResponse(), which throws until it's filled in.
 */
async function resolve(url, { config = {}, fullConfig = null, logger = console } = {}) {
  const parsed = parseUrl(url);
  if (!parsed) {
    const e = new Error(`not a recognised OpenSea URL: ${String(url).slice(0, 120)}`);
    e.code = 'RESOLVER_BAD_URL';
    throw e;
  }

  // TODO: confirm the correct endpoint path for a Robinhood Chain drop.
  // v2 has historically been /collections/{slug}; drop/mint-stage data may live
  // on a different path entirely. Unconfirmed, hence apiBaseUrl is REQUIRED_FILL_ME.
  const path = parsed.slug
    ? `/collections/${parsed.slug}`
    : `/chain/${parsed.chainSlug}/contract/${parsed.address}`;

  const body = await apiGet(path, { config, logger });
  const normalised = mapResponse(body, { parsed, config });
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
