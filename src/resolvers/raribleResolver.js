'use strict';

/**
 * raribleResolver.js — STUB. NOT IMPLEMENTED.
 *
 * Scope (spec §4): Rarible collection URL -> EVM contract address (multi-chain),
 * mint price, go-live time.
 *
 * Not implemented per the build order (OpenSea/Robinhood Chain first). resolve()
 * throws instead of returning placeholder data — arming a target from invented
 * mint data would spend real money.
 *
 * Once implemented this returns the SAME normalised shape as the OpenSea resolver
 * and routes through the SAME src/chains/evm/ executor, since Rarible targets are
 * EVM contracts. The only resolver-specific work is URL parsing + field mapping.
 *
 * =========================================================================
 * TARGET NORMALISED SHAPE — what resolve() must eventually return
 * =========================================================================
 *   {
 *     platform:          'rarible',
 *     chain:             string,        // network KEY from config.networks
 *                                       // (mapped from Rarible's blockchain field)
 *     kind:              'evm',
 *     collectionName:    string,
 *     contractOrProgram: string,        // 0x… contract address
 *     mintPrice:         BigInt,        // WEI per unit
 *     mintStartAt:       number|null,   // epoch ms UTC
 *     maxPerWallet:      number|null,
 *     totalSupply:       number|null,
 *     currencySymbol:    string,        // 'ETH' | 'MATIC' | …
 *     raw:               object
 *   }
 *
 * =========================================================================
 * IMPLEMENTATION NOTES FOR WHOEVER FILLS THIS IN
 * =========================================================================
 * URL forms:
 *   https://rarible.com/collection/<chain>/<address>/items
 *   https://rarible.com/collection/<address>          (chain implied = ethereum)
 *   https://rarible.com/token/<chain>:<address>:<tokenId>
 *
 * Endpoint (VERIFY — Rarible's Protocol API requires an X-API-KEY for most
 * production reads, and the v0.1 paths have moved before):
 *   GET {apiBaseUrl}/collections/{collectionId}
 *   where collectionId is Rarible's CAIP-ish "<CHAIN>:<address>" form,
 *   e.g. "ETHEREUM:0xabc…".
 *
 * Fields to map (NOT CONFIRMED):
 *   name                    -> collectionName
 *   id / address            -> contractOrProgram (strip the CHAIN: prefix)
 *   blockchain              -> chain  (must be mapped through CHAIN_MAP below;
 *                                      do NOT pass Rarible's enum straight
 *                                      through as a config network key)
 *   meta.name               -> fallback collectionName
 *
 * IMPORTANT UNKNOWN: Rarible's collection endpoint is oriented at secondary-market
 * metadata and may NOT expose primary-mint price / go-live time at all. If it
 * doesn't, this resolver has to either read the drop config on-chain or be
 * documented as "secondary-market only, mint timing must be entered manually".
 * Resolve that question before wiring it — don't paper over it with a default.
 *
 * TODO: confirm RARIBLE_API_KEY requirement.
 * TODO: confirm whether Robinhood Chain appears in Rarible's blockchain enum.
 */

const PLATFORM = 'rarible';

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?rarible\.com\/collection\/([a-z]+)\/(0x[a-fA-F0-9]{40})/i,
  /^https?:\/\/(?:www\.)?rarible\.com\/collection\/(0x[a-fA-F0-9]{40})/i,
  /^https?:\/\/(?:www\.)?rarible\.com\/token\/([a-z]+):(0x[a-fA-F0-9]{40}):(\d+)/i,
];

/**
 * Rarible blockchain enum -> our config.networks keys.
 * Intentionally NOT populated with a Robinhood Chain entry: I don't know what
 * Rarible calls that chain (or whether it supports it at all).
 */
const CHAIN_MAP = Object.freeze({
  ethereum: 'ethereum',
  ETHEREUM: 'ethereum',
  polygon: 'polygon',
  POLYGON: 'polygon',
  base: 'base',
  BASE: 'base',
});

function matches(url) {
  return URL_PATTERNS.some((re) => re.test(url));
}

/** Extract { chainHint, address, tokenId? }. Safe to use now. */
function parseUrl(url) {
  let m = url.match(URL_PATTERNS[0]);
  if (m) return { chainHint: m[1].toLowerCase(), address: m[2] };
  m = url.match(URL_PATTERNS[2]);
  if (m) return { chainHint: m[1].toLowerCase(), address: m[2], tokenId: m[3] };
  m = url.match(URL_PATTERNS[1]);
  if (m) return { chainHint: 'ethereum', address: m[1] };
  return null;
}

/** Shape reference for tests/docs. Obviously-fake placeholder values. */
const EXAMPLE_NORMALISED = Object.freeze({
  platform: 'rarible',
  chain: '<config.networks key>',
  kind: 'evm',
  collectionName: '<collection name>',
  contractOrProgram: '0x<contract address>',
  mintPrice: 0n,
  mintStartAt: null,
  maxPerWallet: null,
  totalSupply: null,
  currencySymbol: 'ETH',
  raw: {},
});

async function resolve(url) {
  const parsed = parseUrl(url);
  const err = new Error(
    'Rarible resolver is not implemented yet.\n' +
      `Recognised the URL${parsed ? ` (contract: ${parsed.address}, chain hint: ${parsed.chainHint})` : ''}, ` +
      'but the Rarible API mapping has not been built or verified — and it is not yet ' +
      'confirmed that their collection endpoint exposes primary mint price / start time at all.\n' +
      'Robinhood Chain / OpenSea is the implemented path. See src/resolvers/raribleResolver.js.'
  );
  err.code = 'RESOLVER_NOT_IMPLEMENTED';
  err.platform = PLATFORM;
  throw err;
}

module.exports = { CHAIN_MAP, EXAMPLE_NORMALISED, PLATFORM, URL_PATTERNS, matches, parseUrl, resolve };
