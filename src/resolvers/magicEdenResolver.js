'use strict';

/**
 * magicEdenResolver.js — STUB. NOT IMPLEMENTED.
 *
 * Scope (spec §4): Magic Eden launchpad URL -> Solana Candy Machine v2/v3
 * program address + config, mint price, go-live time.
 *
 * Deliberately not implemented per the build order: Robinhood Chain / OpenSea is
 * priority #1 and Solana is a secondary target. resolve() throws a clear
 * not-implemented error rather than returning fake data, so a user can never arm
 * a target built on invented numbers.
 *
 * =========================================================================
 * TARGET NORMALISED SHAPE — what resolve() must eventually return
 * =========================================================================
 * Every resolver in this directory returns this same object so the scheduler and
 * executors don't care which marketplace a target came from:
 *
 *   {
 *     platform:          'magiceden',
 *     chain:             'solana',        // network key in config.networks
 *     kind:              'solana',
 *     collectionName:    string,
 *     contractOrProgram: string,          // Candy Machine ID (base58)
 *     mintPrice:         BigInt,          // LAMPORTS per unit
 *     mintStartAt:       number|null,     // epoch ms UTC, null = unknown/live
 *     maxPerWallet:      number|null,
 *     totalSupply:       number|null,
 *     currencySymbol:    'SOL',
 *     raw:               object           // untouched API response, for debugging
 *   }
 *
 * =========================================================================
 * IMPLEMENTATION NOTES FOR WHOEVER FILLS THIS IN
 * =========================================================================
 * URL forms to handle:
 *   https://magiceden.io/launchpad/<symbol>
 *   https://magiceden.io/marketplace/<symbol>
 *   https://magiceden.us/launchpad/<symbol>
 *
 * Endpoint (VERIFY BEFORE TRUSTING — ME has changed this API repeatedly and the
 * launchpad endpoints have been partially private/keyed at various points):
 *   GET {apiBaseUrl}/launchpad/collections/{symbol}
 *
 * Expected fields to map (NOT CONFIRMED — treat as a sketch, not a contract):
 *   symbol, name              -> collectionName
 *   candyMachineId / mint     -> contractOrProgram
 *   price (SOL, float)        -> mintPrice  (× 1e9 -> lamports; use string math,
 *                                            never float arithmetic on money)
 *   launchDate (ISO8601)      -> mintStartAt
 *   size / totalItems         -> totalSupply
 *
 * TODO: confirm whether MAGICEDEN_API_KEY is required for launchpad reads.
 * TODO: CM v2 vs v3 differ in mint instruction layout — the resolver must report
 *       which version it found so candyMachine.js can pick the right builder.
 * TODO: paste a real response into __fixtures__ and write the mapper against it.
 */

const PLATFORM = 'magiceden';

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?magiceden\.(?:io|us)\/launchpad\/([A-Za-z0-9_-]+)/i,
  /^https?:\/\/(?:www\.)?magiceden\.(?:io|us)\/marketplace\/([A-Za-z0-9_-]+)/i,
];

function matches(url) {
  return URL_PATTERNS.some((re) => re.test(url));
}

/** Pull the collection symbol out of a launchpad URL. Safe to use now. */
function parseUrl(url) {
  for (const re of URL_PATTERNS) {
    const m = url.match(re);
    if (m) return { symbol: m[1] };
  }
  return null;
}

/** Shape reference for tests/docs. Values are obviously-fake placeholders. */
const EXAMPLE_NORMALISED = Object.freeze({
  platform: 'magiceden',
  chain: 'solana',
  kind: 'solana',
  collectionName: '<collection name>',
  contractOrProgram: '<candy machine id base58>',
  mintPrice: 0n,
  mintStartAt: null,
  maxPerWallet: null,
  totalSupply: null,
  currencySymbol: 'SOL',
  raw: {},
});

async function resolve(url) {
  const parsed = parseUrl(url);
  const err = new Error(
    'Magic Eden resolver is not implemented yet.\n' +
      `Recognised the URL${parsed ? ` (collection symbol: ${parsed.symbol})` : ''}, but the ` +
      'launchpad API mapping has not been built or verified.\n' +
      'Robinhood Chain / OpenSea is the implemented path. See ' +
      'src/resolvers/magicEdenResolver.js for the normalised shape this must return.'
  );
  err.code = 'RESOLVER_NOT_IMPLEMENTED';
  err.platform = PLATFORM;
  throw err;
}

module.exports = { EXAMPLE_NORMALISED, PLATFORM, URL_PATTERNS, matches, parseUrl, resolve };
