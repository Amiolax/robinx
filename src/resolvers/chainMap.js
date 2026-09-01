'use strict';

/**
 * chainMap.js — translate a marketplace's chain slug to our config.networks key.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * Every marketplace names chains differently, and picking the wrong one is a
 * fund-loss bug, not a cosmetic one: a collection can exist at the SAME address
 * on several chains, so resolving "which chain" incorrectly means we'd sign a
 * mint for a contract we didn't intend, on a chain where our balance lives.
 *
 * The mappings below are the stable, documented ones (OpenSea has used `matic`
 * for Polygon and `ethereum` for mainnet since v1 of their API). New chains —
 * Robinhood Chain in particular — are NOT hardcoded, because guessing a slug is
 * how you end up silently matching nothing or, worse, the wrong entry.
 *
 * Instead, unknown chains are wired declaratively: put the marketplace's slug in
 * config/default.json under the network's `marketplaceSlugs` and it is picked up
 * automatically here. That turns "we don't know the slug yet" from a code change
 * into a one-line config edit.
 */

/**
 * Built-in slug -> config.networks key, per platform.
 *
 * OpenSea is the primary (and currently the only enabled) marketplace, so its
 * table is the broad one: every chain identifier OpenSea's v2 API is known to
 * use is listed, mapped to the config.networks key of the same name. Listing a
 * slug here is NOT the same as claiming support — toConfigKey() drops any slug
 * whose target network is absent from config/default.json, so an entry for a
 * chain this deployment hasn't configured resolves to null (a loud error with
 * instructions) rather than to a network that doesn't exist.
 *
 * That is what makes "all chains via OpenSea" true without hardcoding guesses:
 * add the network to config, and its OpenSea link starts working.
 */
const BUILTIN = Object.freeze({
  opensea: Object.freeze({
    // Aliases where OpenSea's name differs from a natural config key.
    eth: 'ethereum',
    mainnet: 'ethereum',
    matic: 'polygon',
    // Identity mappings for the chains OpenSea lists.
    ethereum: 'ethereum',
    polygon: 'polygon',
    base: 'base',
    arbitrum: 'arbitrum',
    arbitrum_nova: 'arbitrum_nova',
    optimism: 'optimism',
    zora: 'zora',
    blast: 'blast',
    avalanche: 'avalanche',
    klaytn: 'klaytn',
    sei: 'sei',
    bsc: 'bsc',
    solana: 'solana',
  }),

  magiceden: Object.freeze({
    ethereum: 'ethereum',
    eth: 'ethereum',
    polygon: 'polygon',
    base: 'base',
    solana: 'solana',
  }),
  rarible: Object.freeze({
    // Rarible's API uses SCREAMING_CASE blockchain names, and its ids are
    // formatted "ETHEREUM:0xabc…" — hence the uppercase keys. Lookup is
    // case-insensitive anyway (see toConfigKey), these are just canonical.
    ethereum: 'ethereum',
    polygon: 'polygon',
    base: 'base',
    solana: 'solana',
  }),
});

const MAP_CACHE = new WeakMap();

/**
 * Build the effective slug->network map for a platform, overlaying whatever the
 * config declares. Config wins over built-ins so an operator can correct a slug
 * that a marketplace has renamed without waiting for a code change.
 *
 * @param platform 'opensea' | 'magiceden' | 'rarible'
 * @param fullConfig the whole loaded config object
 */
function buildMap(platform, fullConfig) {
  if (fullConfig && typeof fullConfig === 'object') {
    let byPlatform = MAP_CACHE.get(fullConfig);
    if (!byPlatform) {
      byPlatform = new Map();
      MAP_CACHE.set(fullConfig, byPlatform);
    }
    if (byPlatform.has(platform)) return byPlatform.get(platform);
  }

  const networks = fullConfig?.networks || null;
  const map = {};

  // Built-ins are only kept if the network they name actually exists in this
  // deployment's config. Without this filter the broad OpenSea table above
  // would happily return e.g. 'blast' for a deployment that has no blast
  // network, and the caller would then look up config.networks.blast, get
  // undefined, and carry a half-null target forward. A slug we cannot honour
  // must read as UNKNOWN (loud, with instructions), not as configured.
  for (const [slug, netKey] of Object.entries(BUILTIN[platform] || {})) {
    if (networks && !networks[netKey]) continue;
    map[slug] = netKey;
  }

  for (const [netKey, net] of Object.entries(networks || {})) {
    // A network can declare, per platform, the slug(s) the marketplace uses.
    //   "marketplaceSlugs": { "opensea": ["robinhood", "robinhood-chain"] }
    const declared = net?.marketplaceSlugs?.[platform];
    if (!declared) continue;
    for (const slug of Array.isArray(declared) ? declared : [declared]) {
      if (typeof slug !== 'string' || !slug.trim()) continue;
      map[slug.trim().toLowerCase()] = netKey;
    }
  }
  if (fullConfig && typeof fullConfig === 'object') {
    MAP_CACHE.get(fullConfig)?.set(platform, map);
  }
  return map;
}


/**
 * @returns {string|null} our config.networks key, or null if the slug is unknown.
 *          Null must be treated as "refuse to proceed", never as a default.
 */
function toConfigKey(platform, slug, fullConfig) {
  if (!slug) return null;
  const map = buildMap(platform, fullConfig);
  const key = String(slug).trim().toLowerCase();
  return map[key] || null;
}

/**
 * Error for an unrecognised chain slug, phrased so the operator knows the exact
 * fix rather than just "unsupported".
 */
function unknownChainError(platform, slug, fullConfig) {
  const known = Object.keys(buildMap(platform, fullConfig)).sort().join(', ');
  const e = new Error(
    `${platform} reports this collection is on chain "${slug}", which is not mapped to any ` +
      `network in config/default.json.\n\n` +
      `Known slugs: ${known || '(none)'}\n\n` +
      `Fix: add the network to config/default.json and declare the slug, e.g.\n` +
      `  "robinhood": { …, "marketplaceSlugs": { "${platform}": ["${slug}"] } }\n\n` +
      `Refusing to guess: the same contract address can exist on several chains, so a wrong ` +
      `guess would sign a mint on the wrong one.`
  );
  e.code = 'RESOLVER_UNKNOWN_CHAIN';
  return e;
}

/**
 * Pick the contract entry matching a chain we support, from a marketplace's
 * (often multi-chain) contracts array.
 *
 * Taking `contracts[0]` blindly — the obvious shortcut — is wrong: OpenSea
 * returns cross-chain collections with entries in arbitrary order, so [0] can
 * easily be a chain the user has no funds on.
 *
 * @param contracts [{address, chain}]
 * @returns {{address, chain, configKey}}
 */
function pickContract(platform, contracts, fullConfig, { preferChain = null } = {}) {
  const list = (Array.isArray(contracts) ? contracts : []).filter((c) => c && c.address);
  if (!list.length) {
    const e = new Error(`${platform} returned no contract address for this collection.`);
    e.code = 'RESOLVER_NO_CONTRACT';
    throw e;
  }

  const mapped = list
    .map((c) => ({
      address: c.address,
      chain: c.chain,
      configKey: toConfigKey(platform, c.chain, fullConfig),
    }))
    .filter((c) => c.configKey);

  if (!mapped.length) {
    throw unknownChainError(platform, list.map((c) => c.chain).join('/'), fullConfig);
  }

  // Honour an explicit preference (e.g. the chain named in the URL itself).
  if (preferChain) {
    const wanted = mapped.find((c) => c.configKey === preferChain);
    if (wanted) return wanted;
  }

  // Prefer the operator's default network, so a multi-chain collection resolves
  // to the chain this deployment is actually set up and funded for.
  const preferred = fullConfig?.defaultNetwork;
  if (preferred) {
    const hit = mapped.find((c) => c.configKey === preferred);
    if (hit) return hit;
  }

  if (mapped.length > 1) {
    const e = new Error(
      `This collection exists on multiple supported chains (${mapped
        .map((c) => c.configKey)
        .join(', ')}).\n\n` +
        `Refusing to choose for you — use /manualtarget to name the chain and contract explicitly.`
    );
    e.code = 'RESOLVER_AMBIGUOUS_CHAIN';
    throw e;
  }

  return mapped[0];
}

module.exports = { BUILTIN, buildMap, pickContract, toConfigKey, unknownChainError };
