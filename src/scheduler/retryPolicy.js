'use strict';

/**
 * retryPolicy.js — backoff, re-broadcast, gas-bump and timeout rules (spec §5).
 *
 * Pure functions only: no network, no clock reads except what's passed in. That
 * keeps the fee-war logic unit-testable without standing up a chain.
 *
 * TWO SEPARATE FAILURE AXES, deliberately kept apart:
 *
 *   - RPC/transport failures  -> EXPECTED on Robinhood Chain (spec §2). Retry on
 *     the next endpoint, do NOT count against the "contract rejected us" budget.
 *   - Contract reverts        -> terminal. The mint is sold out / not live / we
 *     are not allowlisted. Retrying just burns gas, so we stop and report.
 *
 * Anything that fails to classify is treated as retryable-but-counted, so an
 * unknown error can't spin forever.
 */

/** Error classes the executor branches on. */
const ErrorClass = {
  RPC: 'rpc', // transport/node problem — free to retry, not our fault
  REVERT: 'revert', // contract said no — terminal
  UNDERPRICED: 'underpriced', // fee too low to replace/include — bump and retry
  NONCE: 'nonce', // nonce already used — likely already landed
  FUNDS: 'funds', // wallet can't cover value+gas — terminal
  ALREADY_KNOWN: 'already_known', // tx already in mempool — success-ish, keep waiting
  UNKNOWN: 'unknown',
};

const RPC_CODES = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Map a thrown error onto an ErrorClass.
 * Matches on ethers `code` first, then falls back to message sniffing because
 * Orbit-stack / Nitro nodes don't always use standard JSON-RPC error codes.
 */
function classifyError(err) {
  const code = err?.code;
  const msg = String(err?.shortMessage || err?.message || err || '').toLowerCase();

  if (RPC_CODES.has(code)) return ErrorClass.RPC;
  if (code === 'INSUFFICIENT_FUNDS') return ErrorClass.FUNDS;
  if (code === 'NONCE_EXPIRED') return ErrorClass.NONCE;
  if (code === 'REPLACEMENT_UNDERPRICED') return ErrorClass.UNDERPRICED;
  if (code === 'CALL_EXCEPTION' || code === 'TRANSACTION_REVERTED') return ErrorClass.REVERT;

  if (/already known|known transaction|duplicate transaction/.test(msg)) return ErrorClass.ALREADY_KNOWN;
  if (/replacement transaction underpriced|underpriced|fee too low|intrinsic gas too low|max fee per gas less than block base fee/.test(msg))
    return ErrorClass.UNDERPRICED;
  if (/nonce too low|nonce has already been used|invalid nonce/.test(msg)) return ErrorClass.NONCE;
  if (/insufficient funds|gas required exceeds|exceeds balance/.test(msg)) return ErrorClass.FUNDS;
  if (/execution reverted|revert|sold out|not live|not started|exceeds max|allowlist|whitelist/.test(msg))
    return ErrorClass.REVERT;
  if (/socket|econn|timeout|timed out|fetch failed|network|bad gateway|service unavailable|502|503|504|429|rate limit/.test(msg))
    return ErrorClass.RPC;

  return ErrorClass.UNKNOWN;
}

/** Does this error class justify another attempt? */
function isRetryable(errorClass) {
  return (
    errorClass === ErrorClass.RPC ||
    errorClass === ErrorClass.UNDERPRICED ||
    errorClass === ErrorClass.ALREADY_KNOWN ||
    errorClass === ErrorClass.UNKNOWN
  );
}

/** RPC failures are transport noise and shouldn't consume the attempt budget. */
function consumesAttemptBudget(errorClass) {
  return errorClass !== ErrorClass.RPC && errorClass !== ErrorClass.ALREADY_KNOWN;
}

const DEFAULTS = {
  rebroadcastIntervalMs: 400, // spec §5: short interval, don't await confirmation
  maxAttempts: 25,
  totalTimeoutMs: 120_000,
  bumpPercent: 15, // >12.5% so nodes accept it as a replacement
  backoffFactor: 1.0, // 1.0 = flat interval; >1 = widening
  maxIntervalMs: 3_000,
  jitterMs: 75, // de-sync from other bots hammering the same block
  preWarmLeadMs: 30_000, // spec §5: T-30s
};

/**
 * Delay before attempt n (1-indexed). Flat-with-jitter by default: during a mint
 * war you want to stay in the mempool continuously, not exponentially back off.
 */
function nextDelayMs(attempt, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const raw = o.rebroadcastIntervalMs * Math.pow(o.backoffFactor, Math.max(0, attempt - 1));
  const capped = Math.min(raw, o.maxIntervalMs);
  const jitter = o.jitterMs > 0 ? Math.random() * o.jitterMs : 0;
  return Math.round(capped + jitter);
}

/**
 * Fee ladder for attempt n, hard-capped by the user's budget.
 *
 * maxFeePerGas must cover baseFee (which can climb fast at a drop) plus tip, so
 * we headroom the base fee 2x and add the bumped tip — then clamp the whole thing
 * so gasLimit * maxFeePerGas never exceeds maxFeeBudgetWei.
 *
 * All math in BigInt: floating point on wei values is how you overpay by 10^3.
 *
 * @returns {{maxFeePerGas, maxPriorityFeePerGas, atBudgetCeiling, affordable}}
 */
function computeFees({
  attempt,
  baseFeeWei,
  basePriorityFeeWei,
  gasLimit,
  maxFeeBudgetWei,
  valueWei = 0n,
  bumpPercent = DEFAULTS.bumpPercent,
}) {
  const base = BigInt(baseFeeWei);
  const gas = BigInt(gasLimit);
  const budget = BigInt(maxFeeBudgetWei);
  const n = BigInt(Math.max(0, attempt - 1));
  const bp = BigInt(bumpPercent);

  // Compounded bump: tip * (1 + bp/100)^n, integer-only.
  let tip = BigInt(basePriorityFeeWei);
  for (let i = 0n; i < n; i++) tip = (tip * (100n + bp)) / 100n;
  if (tip <= 0n) tip = 1n;

  let maxFee = base * 2n + tip;

  // Budget is a cap on FEES ONLY (value is separately checked against balance).
  const affordableFeePerGas = gas > 0n ? budget / gas : 0n;
  let atBudgetCeiling = false;
  if (affordableFeePerGas > 0n && maxFee > affordableFeePerGas) {
    maxFee = affordableFeePerGas;
    atBudgetCeiling = true;
    if (tip > maxFee) tip = maxFee; // tip can never exceed maxFee
  }

  // Can't even cover the current base fee -> pointless to broadcast.
  const affordable = maxFee > base && maxFee > 0n;

  return {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: tip,
    atBudgetCeiling,
    affordable,
    estimatedFeeWei: maxFee * gas,
    estimatedTotalWei: maxFee * gas + BigInt(valueWei),
  };
}

/**
 * Should we stop? Returns null to continue, or a reason object to halt.
 * Single place that owns the stop conditions so the executor loop stays dumb.
 */
function shouldStop({ attempt, startedAt, now, lastErrorClass, feeState, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };

  if (lastErrorClass && !isRetryable(lastErrorClass)) {
    return { stop: true, reason: `terminal error (${lastErrorClass})`, code: lastErrorClass };
  }
  if (now - startedAt >= o.totalTimeoutMs) {
    return { stop: true, reason: `timeout after ${o.totalTimeoutMs}ms`, code: 'timeout' };
  }
  if (attempt > o.maxAttempts) {
    return { stop: true, reason: `max attempts (${o.maxAttempts}) exhausted`, code: 'max_attempts' };
  }
  if (feeState && feeState.affordable === false) {
    return { stop: true, reason: 'fee budget exhausted — base fee exceeds budget', code: 'budget' };
  }
  return null;
}

/**
 * Honest competitiveness read-out for the confirm card (spec §5: "show budget vs.
 * estimated competitiveness, don't imply guaranteed success").
 *
 * Intentionally vague buckets — anything more precise would be fake precision.
 */
function assessCompetitiveness({ maxFeeBudgetWei, gasLimit, baseFeeWei, basePriorityFeeWei }) {
  const gas = BigInt(gasLimit || 0n);
  const budget = BigInt(maxFeeBudgetWei || 0n);
  const base = BigInt(baseFeeWei || 0n);
  if (gas === 0n || budget === 0n) return { tier: 'unknown', note: 'insufficient data to estimate' };

  const affordableFeePerGas = budget / gas;
  if (affordableFeePerGas <= base) {
    return { tier: 'insufficient', note: 'Budget is below current base fee — this will not land.' };
  }
  const headroomTip = affordableFeePerGas - base;
  const ratio = basePriorityFeeWei > 0n ? Number(headroomTip / BigInt(basePriorityFeeWei)) : 0;

  if (ratio >= 8) return { tier: 'aggressive', note: 'Budget allows large tip bumps. No guarantee of inclusion.' };
  if (ratio >= 3) return { tier: 'competitive', note: 'Budget allows several bumps. No guarantee of inclusion.' };
  if (ratio >= 1) return { tier: 'marginal', note: 'Budget allows minimal bumping — may lose the fee auction.' };
  return { tier: 'weak', note: 'Budget barely covers base fee — likely to lose the fee auction.' };
}

module.exports = {
  DEFAULTS,
  ErrorClass,
  assessCompetitiveness,
  classifyError,
  computeFees,
  consumesAttemptBudget,
  isRetryable,
  nextDelayMs,
  shouldStop,
};
