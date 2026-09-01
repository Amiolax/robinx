'use strict';

/**
 * mintStage.js — read a drop's MINT PRICE and START TIME from the contract.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original design took price + start time from a marketplace API response.
 * That is the wrong source of truth for money. A marketplace API can be stale,
 * can report a display price in ETH while we need wei, can report a presale
 * stage when we need the public one, and can change field names without notice.
 * Any of those silently spends real funds at the wrong number or the wrong
 * moment — the exact failure mode called out in openseaResolver.js.
 *
 * The contract, by contrast, IS the authority: whatever it says the price and
 * start time are is precisely what it will enforce at mint time. So we read it
 * directly, over eth_call, for free.
 *
 * The marketplace API is still used — but only for the thing it is genuinely
 * reliable at: mapping a human URL slug to a contract address + chain.
 *
 * SUPPORTED DROP PATTERNS (probed in descending order of confidence)
 * -----------------------------------------------------------------
 *   1. SeaDrop v1     — OpenSea's drop standard. Config lives on the shared
 *                       SeaDrop contract: getPublicDrop(nft) -> struct.
 *   2. SeaDrop v2     — config lives on the token itself: publicDrop() -> struct
 *                       (adds startPrice/endPrice for descending-price drops).
 *   3. Thirdweb Drop  — getActiveClaimConditionId() + getClaimConditionById().
 *                       Very common for non-OpenSea-native drops.
 *   4. Ad-hoc getters — mintPrice()/price()/cost() + publicSaleStartTime() etc.
 *                       The long tail of hand-written drop contracts.
 *
 * EVERY read is a plain eth_call wrapped so that a revert means "this contract
 * isn't that pattern", never an exception that aborts the whole probe. If no
 * pattern matches we return null and the caller must ask the user for the
 * values explicitly (see /manualtarget) rather than guessing.
 */

const { Interface } = require('ethers');

/**
 * OpenSea's SeaDrop v1 singleton. Deployed at the same deterministic address on
 * every chain OpenSea has shipped it to (CREATE2), which is why one constant
 * works across Ethereum/Base/Polygon/Arbitrum. Overridable per-network via
 * config.networks.<net>.seadropAddress in case a chain has a different deploy.
 */
const SEADROP_V1_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

/**
 * Thirdweb's sentinel for "pay in the chain's native coin". If a claim
 * condition names any other currency it's an ERC20-priced drop, which this bot
 * cannot pay for (it only sends native value), so we refuse instead of firing a
 * transaction that is guaranteed to revert.
 */
const NATIVE_CURRENCY_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/* ------------------------------------------------------------------ ABIs ---- */

const ABI_SEADROP_V1 = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
];

// SeaDrop 2.x moved config onto the token and split price into start/end to
// support descending-price ("dutch") drops. We take startPrice as the worst case
// the user could pay at T=0, which is the correct conservative read.
const ABI_SEADROP_V2 = [
  'function publicDrop() view returns (tuple(uint80 startPrice, uint80 endPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
];

// Older/simpler SeaDrop-style tokens expose the v1 struct shape on themselves.
const ABI_SEADROP_V1_ON_TOKEN = [
  'function publicDrop() view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
];

const ABI_THIRDWEB = [
  'function getActiveClaimConditionId() view returns (uint256)',
  'function getClaimConditionById(uint256 conditionId) view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata))',
];

/** Single-value price getters, most explicit first. */
const PRICE_GETTERS = [
  'function publicPrice() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function publicMintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function PRICE() view returns (uint256)',
  'function mintFee() view returns (uint256)',
  'function salePrice() view returns (uint256)',
  'function tokenPrice() view returns (uint256)',
];

/** Single-value start-time getters (unix SECONDS by convention on-chain). */
const START_TIME_GETTERS = [
  'function publicSaleStartTime() view returns (uint256)',
  'function publicSaleStart() view returns (uint256)',
  'function saleStartTime() view returns (uint256)',
  'function mintStartTime() view returns (uint256)',
  'function startTime() view returns (uint256)',
  'function publicMintStart() view returns (uint256)',
  'function saleStart() view returns (uint256)',
];

/** Boolean "is the public sale open right now" flags. */
const ACTIVE_FLAG_GETTERS = [
  'function saleIsActive() view returns (bool)',
  'function publicSaleActive() view returns (bool)',
  'function isPublicMintActive() view returns (bool)',
  'function mintActive() view returns (bool)',
  'function publicMintOpen() view returns (bool)',
];

/** Per-wallet cap getters, used only to warn the user about their qty. */
const MAX_PER_WALLET_GETTERS = [
  'function maxPerWallet() view returns (uint256)',
  'function maxMintsPerWallet() view returns (uint256)',
  'function maxPerAddress() view returns (uint256)',
  'function maxMintAmount() view returns (uint256)',
];

/* -------------------------------------------------------------- helpers ---- */

/**
 * eth_call one view function and decode it. Returns null on ANY failure.
 *
 * "Any failure" is deliberate and load-bearing: a contract that doesn't
 * implement `mintPrice()` reverts, and that is a normal, expected answer to the
 * question "are you this kind of drop?" — not an error worth propagating.
 */
async function tryRead(provider, to, signature, args = []) {
  try {
    const iface = new Interface([signature]);
    const fn = iface.fragments[0];
    const data = iface.encodeFunctionData(fn, args);
    const raw = await provider.call({ to, data });
    // '0x' means the call hit a non-contract or a fallback that returned
    // nothing. Decoding that would throw; treat it as "not implemented".
    if (!raw || raw === '0x') return null;
    const decoded = iface.decodeFunctionResult(fn, raw);
    return decoded.length === 1 ? decoded[0] : decoded;
  } catch {
    return null;
  }
}

/** First getter in `signatures` that returns a value. */
async function tryReadAny(provider, to, signatures) {
  for (const sig of signatures) {
    const v = await tryRead(provider, to, sig);
    if (v !== null && v !== undefined) {
      return { value: v, signature: sig };
    }
  }
  return null;
}

/**
 * Convert an on-chain timestamp to epoch MILLISECONDS.
 *
 * On-chain times are unix seconds by near-universal convention, but a
 * hand-written contract occasionally stores millis. Discriminating on magnitude
 * is safe here because the two ranges are ~1000x apart: any value that already
 * looks like present-day millis (>= 1e12) is passed through, everything else is
 * treated as seconds. Getting this backwards misfires a snipe by ~55 years,
 * which is why it is a named function with a test rather than an inline `*1000`.
 */
function timestampToMs(raw) {
  if (raw === null || raw === undefined) return null;
  const n = BigInt(raw);
  if (n === 0n) return null; // 0 = "unset", not 1970

  // Reject sentinels BEFORE converting. This ordering matters: type(uint64).max
  // is a common "never/unset" marker, and Number() on it silently loses
  // precision (18446744073709551615 -> 18446744073709552000) producing a
  // plausible-looking millisecond value instead of an obvious error. That
  // value would then be handed to setTimeout as a drop time roughly 584
  // million years out — the snipe never fires and nothing looks broken.
  // Anything past year 2100 cannot be a real mint time, so it is "unknown".
  const MAX_PLAUSIBLE_MS = 4_102_444_800_000n; // 2100-01-01T00:00:00Z
  if (n >= 1_000_000_000_000n) {
    return n > MAX_PLAUSIBLE_MS ? null : Number(n); // already millis
  }
  const ms = n * 1000n;
  return ms > MAX_PLAUSIBLE_MS ? null : Number(ms);
}


/** A sane far-future sentinel check: many contracts use max-uint for "never". */
function isSentinelFuture(ms) {
  if (ms === null) return false;
  // > year 2100 is never a real drop time; it's a sentinel.
  return ms > 4_102_444_800_000;
}

function normaliseCurrency(addr) {
  if (!addr) return null;
  return String(addr).toLowerCase();
}

function isNativeCurrency(addr) {
  const a = normaliseCurrency(addr);
  return a === null || a === NATIVE_CURRENCY_SENTINEL || a === ZERO_ADDRESS;
}

/* -------------------------------------------------------- stage readers ---- */

/** SeaDrop v1: config held on the shared SeaDrop contract, keyed by token. */
async function readSeaDropV1({ provider, contract, seadropAddress, logger }) {
  const drop = await tryRead(provider, seadropAddress, ABI_SEADROP_V1[0], [contract]);
  if (!drop) return null;

  const mintPriceWei = BigInt(drop.mintPrice ?? drop[0]);
  const startAtMs = timestampToMs(drop.startTime ?? drop[1]);
  const endAtMs = timestampToMs(drop.endTime ?? drop[2]);
  const maxPerWallet = Number(drop.maxTotalMintableByWallet ?? drop[3]);

  // An all-zero struct is what SeaDrop returns for a token it has never been
  // configured for. That is "no drop here", not "a free mint at epoch 0".
  if (mintPriceWei === 0n && !startAtMs && !maxPerWallet) return null;

  logger?.info?.(`[mintStage] SeaDrop v1 config found for ${contract}`);
  return {
    source: 'seadrop-v1',
    confidence: 'high',
    mintPriceWei,
    startAtMs,
    endAtMs,
    maxPerWallet: maxPerWallet || null,
    currency: null,
    feeBps: Number(drop.feeBps ?? drop[4]) || null,
  };
}

/** SeaDrop v2 (and v1-shaped-on-token): config held on the token. */
async function readSeaDropOnToken({ provider, contract, logger }) {
  // Try the 7-field v2 struct first. If the token is actually v1-shaped the
  // decode fails cleanly and we fall through to the 6-field shape.
  const v2 = await tryRead(provider, contract, ABI_SEADROP_V2[0]);
  if (v2) {
    const startPrice = BigInt(v2.startPrice ?? v2[0]);
    const endPrice = BigInt(v2.endPrice ?? v2[1]);
    const startAtMs = timestampToMs(v2.startTime ?? v2[2]);
    const maxPerWallet = Number(v2.maxTotalMintableByWallet ?? v2[4]);
    if (!(startPrice === 0n && endPrice === 0n && !startAtMs && !maxPerWallet)) {
      logger?.info?.(`[mintStage] SeaDrop v2 publicDrop() found on ${contract}`);
      return {
        source: 'seadrop-v2',
        confidence: 'high',
        // Take the HIGHER of start/end price. On a descending-price drop we fire
        // at T=0 when the price is at its maximum, so budgeting for the end
        // price would under-fund the transaction and revert.
        mintPriceWei: startPrice > endPrice ? startPrice : endPrice,
        startAtMs,
        endAtMs: timestampToMs(v2.endTime ?? v2[3]),
        maxPerWallet: maxPerWallet || null,
        currency: null,
        feeBps: Number(v2.feeBps ?? v2[5]) || null,
      };
    }
  }

  const v1 = await tryRead(provider, contract, ABI_SEADROP_V1_ON_TOKEN[0]);
  if (v1) {
    const mintPriceWei = BigInt(v1.mintPrice ?? v1[0]);
    const startAtMs = timestampToMs(v1.startTime ?? v1[1]);
    const maxPerWallet = Number(v1.maxTotalMintableByWallet ?? v1[3]);
    if (!(mintPriceWei === 0n && !startAtMs && !maxPerWallet)) {
      logger?.info?.(`[mintStage] SeaDrop v1-shaped publicDrop() found on ${contract}`);
      return {
        source: 'seadrop-v1-token',
        confidence: 'high',
        mintPriceWei,
        startAtMs,
        endAtMs: timestampToMs(v1.endTime ?? v1[2]),
        maxPerWallet: maxPerWallet || null,
        currency: null,
        feeBps: Number(v1.feeBps ?? v1[4]) || null,
      };
    }
  }

  return null;
}

/** Thirdweb DropERC721 / claim conditions. */
async function readThirdwebClaimCondition({ provider, contract, logger }) {
  const id = await tryRead(provider, contract, ABI_THIRDWEB[0]);
  if (id === null || id === undefined) return null;

  const cond = await tryRead(provider, contract, ABI_THIRDWEB[1], [id]);
  if (!cond) return null;

  const startAtMs = timestampToMs(cond.startTimestamp ?? cond[0]);
  const pricePerToken = BigInt(cond.pricePerToken ?? cond[5]);
  const currency = cond.currency ?? cond[6];
  const quantityLimitPerWallet = BigInt(cond.quantityLimitPerWallet ?? cond[3]);
  const merkleRoot = cond.merkleRoot ?? cond[4];

  // A non-zero merkle root means the ACTIVE condition is allowlist-gated. Firing
  // into it without a proof reverts every time, so this must reach the user as a
  // warning rather than being quietly dropped.
  const allowlistOnly =
    merkleRoot &&
    String(merkleRoot) !== '0x0000000000000000000000000000000000000000000000000000000000000000';

  if (!isNativeCurrency(currency)) {
    logger?.warn?.(`[mintStage] thirdweb condition is ERC20-priced (${currency}) on ${contract}`);
    return {
      source: 'thirdweb-claim-condition',
      confidence: 'high',
      mintPriceWei: pricePerToken,
      startAtMs,
      endAtMs: null,
      maxPerWallet:
        quantityLimitPerWallet > 0n && quantityLimitPerWallet < 1_000_000n
          ? Number(quantityLimitPerWallet)
          : null,
      currency: normaliseCurrency(currency),
      erc20Priced: true,
      allowlistOnly: Boolean(allowlistOnly),
    };
  }

  logger?.info?.(`[mintStage] thirdweb claim condition #${id} found on ${contract}`);
  return {
    source: 'thirdweb-claim-condition',
    confidence: 'high',
    mintPriceWei: pricePerToken,
    startAtMs,
    endAtMs: null,
    maxPerWallet:
      quantityLimitPerWallet > 0n && quantityLimitPerWallet < 1_000_000n
        ? Number(quantityLimitPerWallet)
        : null,
    currency: null,
    allowlistOnly: Boolean(allowlistOnly),
  };
}

/**
 * Long tail: hand-written contracts with ad-hoc getters.
 *
 * Confidence is 'medium' because we're inferring a drop config from unrelated
 * public getters. The caller surfaces that to the user so they can sanity-check
 * the price before arming.
 */
async function readAdHocGetters({ provider, contract, logger }) {
  const [price, start, active, maxWallet] = await Promise.all([
    tryReadAny(provider, contract, PRICE_GETTERS),
    tryReadAny(provider, contract, START_TIME_GETTERS),
    tryReadAny(provider, contract, ACTIVE_FLAG_GETTERS),
    tryReadAny(provider, contract, MAX_PER_WALLET_GETTERS),
  ]);

  // Nothing at all -> not a recognisable drop.
  if (!price && !start && !active) return null;

  let startAtMs = start ? timestampToMs(start.value) : null;
  if (isSentinelFuture(startAtMs)) startAtMs = null;

  const isActiveNow = active ? Boolean(active.value) : null;

  logger?.info?.(
    `[mintStage] ad-hoc getters on ${contract}: ` +
      `price=${price?.signature ?? 'none'} start=${start?.signature ?? 'none'} ` +
      `active=${active ? String(active.value) : 'unknown'}`
  );

  return {
    source: 'adhoc-getters',
    confidence: 'medium',
    mintPriceWei: price ? BigInt(price.value) : null,
    startAtMs,
    endAtMs: null,
    maxPerWallet:
      maxWallet && BigInt(maxWallet.value) > 0n && BigInt(maxWallet.value) < 1_000_000n
        ? Number(maxWallet.value)
        : null,
    currency: null,
    isActiveNow,
    readVia: {
      price: price?.signature ?? null,
      start: start?.signature ?? null,
      active: active?.signature ?? null,
    },
  };
}

/* ------------------------------------------------------------ public API ---- */

/**
 * Read the public mint stage for `contract`.
 *
 * @returns {Promise<object|null>} stage descriptor, or null if the contract
 *          exposes no recognisable public drop config. Null is a legitimate
 *          answer — the caller must then get values from the user, not invent
 *          them.
 */
async function readPublicMintStage({ provider, contract, network = {}, logger = console }) {
  const seadropAddress = network.seadropAddress || SEADROP_V1_ADDRESS;

  // Confirm there is actually code at the address first. Probing a non-contract
  // produces a confusing cascade of nulls that looks like an unsupported drop
  // rather than a wrong address.
  try {
    const code = await provider.getCode(contract);
    if (!code || code === '0x') {
      const e = new Error(
        `No contract code at ${contract} on ${network.displayName || network.name || 'this network'}. ` +
          `Either the address is wrong or it lives on a different chain.`
      );
      e.code = 'MINTSTAGE_NOT_A_CONTRACT';
      throw e;
    }
  } catch (err) {
    if (err.code === 'MINTSTAGE_NOT_A_CONTRACT') throw err;
    // getCode failing is an RPC problem; let the caller's failover handle it.
    throw err;
  }

  const readers = [
    () => readSeaDropV1({ provider, contract, seadropAddress, logger }),
    () => readSeaDropOnToken({ provider, contract, logger }),
    () => readThirdwebClaimCondition({ provider, contract, logger }),
    () => readAdHocGetters({ provider, contract, logger }),
  ];

  for (const read of readers) {
    const stage = await read();
    if (stage) return stage;
  }

  logger?.warn?.(`[mintStage] no recognised drop config on ${contract}`);
  return null;
}

/**
 * Human-readable summary for the confirm card. Kept here so the wording stays
 * consistent between the wizard, /list and /inspect.
 */
function describeStage(stage) {
  if (!stage) return 'No on-chain drop config found (price/time must be supplied manually).';
  const bits = [`source: ${stage.source} (${stage.confidence} confidence)`];
  if (stage.allowlistOnly) {
    bits.push('WARNING: the active stage is allowlist-gated — a public mint will revert');
  }
  if (stage.erc20Priced) {
    bits.push(`WARNING: priced in ERC20 ${stage.currency} — this bot can only pay native coin`);
  }
  if (stage.isActiveNow === false) {
    bits.push('contract reports the public sale is NOT active yet');
  }
  if (stage.maxPerWallet) bits.push(`max ${stage.maxPerWallet} per wallet`);
  return bits.join('; ');
}

module.exports = {
  ABI_SEADROP_V1,
  ABI_THIRDWEB,
  ACTIVE_FLAG_GETTERS,
  NATIVE_CURRENCY_SENTINEL,
  PRICE_GETTERS,
  SEADROP_V1_ADDRESS,
  START_TIME_GETTERS,
  describeStage,
  isNativeCurrency,
  isSentinelFuture,
  readAdHocGetters,
  readPublicMintStage,
  readSeaDropOnToken,
  readSeaDropV1,
  readThirdwebClaimCondition,
  timestampToMs,
  tryRead,
  tryReadAny,
};
