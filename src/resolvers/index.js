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

const RESOLVERS = [opensea, magiceden, rarible];

/** Implementation status, surfaced to the user in /newtarget and the README. */
const STATUS = Object.freeze({
  opensea: 'wired (URL + transport + validation); response mapping pending a real sample',
  magiceden: 'stub — not implemented',
  rarible: 'stub — not implemented',
});

/** @returns platform name or null */
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
    const e = new Error(
      'Unsupported link. Supported: OpenSea (opensea.io/collection/…), ' +
        'Magic Eden (magiceden.io/launchpad/… — stub), Rarible (rarible.com/collection/… — stub).'
    );
    e.code = 'RESOLVER_UNSUPPORTED';
    throw e;
  }

  const resolver = getResolver(platform);
  const resolved = await resolver.resolve(url, {
    config: config?.resolvers?.[platform] || {},
    fullConfig: config,
    logger,
  });
  return { ...resolved, sourceUrl: url };
}

module.exports = { RESOLVERS, STATUS, cleanUrl, detectPlatform, getResolver, resolveUrl };
