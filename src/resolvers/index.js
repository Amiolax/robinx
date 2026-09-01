'use strict';


/**
 * index.js — dispatch a URL to the right resolver (spec §4).
 *
 * Pluggable by design: spec §4 notes this layer is the most likely thing to break
 * when a marketplace changes its API, so each platform is isolated and one
 * failing (or being unimplemented) never affects the others.
 */

const opensea = require('./openseaResolver');
const magiceden = require('./magicEdenResolver');
const rarible = require('./raribleResolver');
const db = require('../store/db');


const RESOLVERS = [opensea, magiceden, rarible];
const TARGET_CACHE_TTL_MS = 60_000;
const targetCache = new Map();
const targetInflight = new Map();
let mintStageCache = null;

/** Human labels, keyed by platform. */
const DISPLAY_NAME = Object.freeze({
  opensea: 'OpenSea',
  magiceden: 'Magic Eden',
  rarible: 'Rarible',
});

/**
 * Which marketplaces are LIVE, and which are announced-but-not-live.
 *
 * OpenSea is enabled on every chain this deployment has configured. Magic Eden
 * and Rarible are code-complete but gated OFF because we have no API keys for
 * them yet — and a resolver without a key does not fail cleanly, it fails at the
 * worst moment: the user pastes a link, waits, and gets a 401 mid-wizard, or
 * (worse) during the minutes before a drop when they have no time to recover.
 *
 * Gating them here turns that into an immediate, honest "coming soon" with a
 * working alternative offered in the same message. Flipping one to live is a
 * config edit, not a code change: set resolvers.<platform>.enabled = true in
 * config/default.json once the key is in the environment.
 */
const DEFAULT_ENABLED = Object.freeze({
  opensea: true,
  magiceden: false,
  rarible: false,
});

/** Static fallback labels (used when no config is passed, e.g. in tests). */
const STATUS = Object.freeze({
  opensea: 'live — all configured chains, collection + asset links',
  magiceden: 'coming soon (awaiting API key)',
  rarible: 'coming soon (awaiting API key)',
});

function getMintStage() {
  if (!mintStageCache) mintStageCache = require('../chains/evm/mintStage');
  return mintStageCache;
}

function cloneStage(stage) {
  if (!stage || typeof stage !== 'object') return stage;
  return {
    ...stage,
    readVia: stage.readVia ? { ...stage.readVia } : stage.readVia,
  };
}

function cloneResolved(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    stage: cloneStage(value.stage),
    raw: value.raw && typeof value.raw === 'object' ? { ...value.raw } : value.raw,
  };
}

/**
 * Is this marketplace live on this deployment?
 * Config wins over the built-in default so enabling one needs no code change.
 */
function isEnabled(platform, config = null) {
  const declared = config?.resolvers?.[platform]?.enabled;
  if (typeof declared === 'boolean') return declared;
  return Boolean(DEFAULT_ENABLED[platform]);
}

/** Platforms currently live, in dispatch order. */
function enabledPlatforms(config = null) {
  return RESOLVERS.map((r) => r.PLATFORM).filter((p) => isEnabled(p, config));
}

/** Platforms wired but gated off pending credentials. */
function comingSoonPlatforms(config = null) {
  return RESOLVERS.map((r) => r.PLATFORM).filter((p) => !isEnabled(p, config));
}

/**
 * One-line status per marketplace for /newtarget, /help and the README, so all
 * three read from the same source and cannot drift apart.
 */
function statusFor(platform, config = null) {
  if (!isEnabled(platform, config)) return 'COMING SOON — not yet enabled (no API key)';
  if (platform === 'opensea') return 'LIVE — every configured chain, collection + asset links';
  return 'LIVE';
}

/** @returns [{platform, name, enabled, status}] — ready to render as a list. */
function marketplaceStatus(config = null) {
  return RESOLVERS.map((r) => ({
    platform: r.PLATFORM,
    name: DISPLAY_NAME[r.PLATFORM] || r.PLATFORM,
    enabled: isEnabled(r.PLATFORM, config),
    status: statusFor(r.PLATFORM, config),
  }));
}

/**
 * Error for a link whose marketplace is recognised but not switched on.
 *
 * Deliberately NOT the same as "unsupported": the user pasted a valid link to a
 * real marketplace, so telling them it is unsupported would be a lie and would
 * send them looking for a mistake they did not make. It also always names the
 * two routes that DO work right now, because a dead end with no alternative is
 * what makes people give up on a tool.
 */
function comingSoonError(platform, config = null) {
  const name = DISPLAY_NAME[platform] || platform;
  const live = enabledPlatforms(config)
    .map((p) => DISPLAY_NAME[p] || p)
    .join(', ');

  const e = new Error(
    `${name} support is coming soon — it is not enabled yet.\n\n` +
      `We are waiting on a ${name} API key. The link you sent is valid; the ` +
      `integration just is not switched on.\n\n` +
      `What works right now:\n` +
      `• ${live || 'OpenSea'} links — paste one instead\n` +
      `• /manualtarget <network> <contract> — needs no marketplace at all, and ` +
      `reads the price and start time straight off the contract\n\n` +
      `If you have the ${name} collection's contract address, /manualtarget is ` +
      `actually the faster path.`
  );
  e.code = 'RESOLVER_COMING_SOON';
  e.platform = platform;
  return e;
}

/** @returns platform name or null. Matches regardless of enabled state, so a
 *  gated marketplace can be answered precisely instead of as "unsupported". */
function detectPlatform(url) {
  const r = RESOLVERS.find((x) => x.matches(url));
  return r ? r.PLATFORM : null;
}


function getResolver(platform) {
  const r = RESOLVERS.find((x) => x.PLATFORM === platform);
  if (!r) throw new Error(`no resolver for platform "${platform}"`);
  return r;
}

/** Normalise user input before pattern matching (strips tracking params etc). */
function cleanUrl(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/https?:\/\/\S+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Resolve a marketplace URL to a normalised target.
 *
 * Errors are passed through with their `code` intact so bot.js can render a
 * useful message (unsupported link vs. not-implemented vs. API down) instead of
 * a generic failure.
 */
async function resolveUrl(input, { config, logger = console } = {}) {
  const url = cleanUrl(input);
  if (!url) {
    const e = new Error('No URL found in that message. Paste a full https:// marketplace link.');
    e.code = 'RESOLVER_BAD_URL';
    throw e;
  }

  const platform = detectPlatform(url);
  if (!platform) {
    const soon = comingSoonPlatforms(config)
      .map((p) => DISPLAY_NAME[p] || p)
      .join(' and ');

    const e = new Error(
      'Unsupported link.\n\nSupported now:\n' +
        '• OpenSea — opensea.io/collection/<slug> or opensea.io/assets/<chain>/<address>\n' +
        '  (works on every chain this bot has configured)\n\n' +
        (soon ? `Coming soon: ${soon}.\n\n` : '') +
        'Or skip the marketplace entirely: /manualtarget <network> <contract>'
    );

    e.code = 'RESOLVER_UNSUPPORTED';
    throw e;
  }

  // Recognised, but switched off pending credentials. This is checked BEFORE the
  // resolver runs so a gated marketplace costs the user no waiting and produces
  // no confusing 401 — see comingSoonError() for why it is its own error code.
  if (!isEnabled(platform, config)) throw comingSoonError(platform, config);

  const resolver = getResolver(platform);

  const resolved = await resolver.resolve(url, {
    config: config?.resolvers?.[platform] || {},
    fullConfig: config,
    logger,
  });
  return { ...resolved, sourceUrl: url };
}

/**
 * Full resolution: marketplace URL -> contract, then CONTRACT -> price/start time.
 *
 * This is the function bot.js should call. It exists so the two-step nature of
 * resolution (marketplace for identity, chain for money) lives in one place
 * rather than being re-implemented by every caller.
 *
 * The on-chain read is best-effort by design: if a contract exposes no
 * recognisable drop config we return the target with nulls and let the caller
 * ask the user, which is strictly better than inventing a price. What we never
 * do is proceed to arming with unknown values — that check lives in the wizard.
 *
 * @param openPool  (network) => pool   a factory returning something with
 *                  withFailover()/destroy(). Injected rather than imported so
 *                  this module stays unit-testable with a fake provider.
 */
async function resolveTarget(input, { config, logger = console, openPool = null } = {}) {
  const cleaned = cleanUrl(input);
  const cacheKey = cleaned || String(input || '').trim();
  const cached = targetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cloneResolved(cached.value);

  if (targetInflight.has(cacheKey)) return cloneResolved(await targetInflight.get(cacheKey));

  const resolvePromise = (async () => {
    const resolved = await resolveUrl(input, { config, logger });
    const network = config?.networks?.[resolved.chain];

    if (!network || network.kind !== 'evm' || !openPool) return { ...resolved, stage: null };

    // A network with placeholder RPC/chainId can't be read; surface the resolved
    // contract anyway so the user sees progress and a precise reason.
    try {
      db.assertNetworkUsable(network);
    } catch (err) {
      logger.warn?.(`[resolvers] skipping on-chain read: ${err.message}`);
      return { ...resolved, stage: null, stageError: err.message };
    }

    let pool;
    try {
      pool = await openPool(network);
      const stage = await pool.withFailover(
        (provider) =>
          getMintStage().readPublicMintStage({ provider, contract: resolved.contractOrProgram, network, logger }),
        { label: 'readPublicMintStage' }
      );
      return {
        ...resolved,
        stage,
        mintPrice: stage?.mintPriceWei ?? null,
        mintStartAt: stage?.startAtMs ?? null,
        maxPerWallet: stage?.maxPerWallet ?? resolved.maxPerWallet ?? null,
      };
    } catch (err) {
      logger.warn?.(`[resolvers] on-chain stage read failed: ${err.message}`);
      return { ...resolved, stage: null, stageError: err.message };
    } finally {
      if (pool) pool.destroy();
    }
  })();

  targetInflight.set(cacheKey, resolvePromise);
  try {
    const result = await resolvePromise;
    targetCache.set(cacheKey, { value: result, expiresAt: Date.now() + TARGET_CACHE_TTL_MS });
    return cloneResolved(result);
  } finally {
    targetInflight.delete(cacheKey);
  }
}

module.exports = {
  DEFAULT_ENABLED,
  DISPLAY_NAME,
  RESOLVERS,
  STATUS,
  cleanUrl,
  comingSoonError,
  comingSoonPlatforms,
  detectPlatform,
  enabledPlatforms,
  getResolver,
  isEnabled,
  marketplaceStatus,
  resolveTarget,
  resolveUrl,
  statusFor,
};

