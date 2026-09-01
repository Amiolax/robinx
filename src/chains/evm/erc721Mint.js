'use strict';

/**
 * erc721Mint.js — generic EVM mint calldata builder.
 *
 * WHY THIS IS SHAPED THIS WAY
 * ---------------------------
 * On Robinhood Chain (Arbitrum Orbit L2, launched 2026-07-01) most drop contracts
 * are NOT verified on a block explorer yet, so we frequently cannot fetch a real
 * ABI. Per spec section 2 we therefore:
 *
 *   1. Try a verified-ABI lookup first (pluggable; see resolveAbi()).
 *   2. Fall back to a fixed set of well-known mint()/claim() selectors.
 *   3. PROBE each candidate with eth_call + estimateGas before we ever sign or
 *      broadcast, and FAIL LOUDLY if every candidate reverts.
 *
 * (3) is the important one. A blind "just send mint(uint256) and hope" burns real
 * gas on a revert and tells the user nothing. We simulate first, off-chain, for
 * free, and surface the revert reason.
 *
 * NOTE: probing costs a few RPC round-trips, so the scheduler runs it during the
 * T-30s pre-warm window (see src/scheduler/scheduler.js), never at T=0.
 */

const { Interface, id: keccakId } = require('ethers');

const ABI_CACHE_TTL_MS = 300_000;
const abiCache = new Map();
const abiInflight = new Map();

/**
 * Candidate mint entrypoints, ordered most-common-first.
 *
 * `args` describes how to materialise the argument list at build time from
 * { qty, minter }. Keep these cheap and total — no network access.
 */
const CANDIDATE_MINT_FUNCTIONS = [
  {
    signature: 'function mint(uint256 quantity) payable',
    name: 'mint(uint256)',
    args: ({ qty }) => [BigInt(qty)],
  },
  {
    signature: 'function mint() payable',
    name: 'mint()',
    // Single-unit mint: qty>1 must be handled by sending N separate txs.
    args: () => [],
    singleUnitOnly: true,
  },
  {
    signature: 'function mint(address to, uint256 quantity) payable',
    name: 'mint(address,uint256)',
    args: ({ qty, minter }) => [minter, BigInt(qty)],
  },
  {
    signature: 'function claim(uint256 quantity) payable',
    name: 'claim(uint256)',
    args: ({ qty }) => [BigInt(qty)],
  },
  {
    signature: 'function claim() payable',
    name: 'claim()',
    args: () => [],
    singleUnitOnly: true,
  },
  {
    signature: 'function publicMint(uint256 quantity) payable',
    name: 'publicMint(uint256)',
    args: ({ qty }) => [BigInt(qty)],
  },
  {
    signature: 'function mintPublic(uint256 quantity) payable',
    name: 'mintPublic(uint256)',
    args: ({ qty }) => [BigInt(qty)],
  },
  {
    signature: 'function purchase(uint256 quantity) payable',
    name: 'purchase(uint256)',
    args: ({ qty }) => [BigInt(qty)],
  },
];

/** 4-byte selector for a human-readable signature fragment. */
function selectorOf(fragmentSignature) {
  // 'function mint(uint256 quantity) payable' -> 'mint(uint256)'
  const iface = new Interface([fragmentSignature]);
  const fn = iface.fragments[0];
  return keccakId(`${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`).slice(0, 10);
}

/** Exported for diagnostics / tests: the selector set we fall back to. */
const GENERIC_MINT_SELECTORS = CANDIDATE_MINT_FUNCTIONS.map((c) => ({
  name: c.name,
  selector: selectorOf(c.signature),
}));

/**
 * Encode calldata for one candidate.
 * @returns {{ data: string, candidate: object }}
 */
function encodeCandidate(candidate, { qty, minter }) {
  const iface = new Interface([candidate.signature]);
  const fn = iface.fragments[0];
  const effectiveQty = candidate.singleUnitOnly ? 1 : qty;
  const data = iface.encodeFunctionData(fn, candidate.args({ qty: effectiveQty, minter }));
  return { data, candidate };
}

/**
 * Attempt to fetch a verified ABI for `address`.
 *
 * TODO(robinhood-chain): fill in once a block explorer with a public verified-
 * source API exists for this chain and we know its base URL + whether it needs a
 * key. Wire the endpoint via config.networks.<net>.explorerApi and env var
 * EXPLORER_API_KEY. Until then this returns null and we go straight to the
 * generic selector fallback, which is the expected path on this chain today.
 *
 * Deliberately never throws: an explorer outage must not block a mint.
 */
async function resolveAbi(address, { explorerApi } = {}) {
  if (!explorerApi || !explorerApi.baseUrl) return null;
  const cacheKey = `${explorerApi.baseUrl}|${String(address || '').toLowerCase()}`;
  const cached = abiCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  if (abiInflight.has(cacheKey)) return abiInflight.get(cacheKey);

  const load = (async () => {
    try {
      // Etherscan-compatible shape; adjust when the real explorer is known.
      const url =
        `${explorerApi.baseUrl}?module=contract&action=getabi` +
        `&address=${address}` +
        (explorerApi.apiKey ? `&apikey=${explorerApi.apiKey}` : '');
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const body = await res.json();
      if (body.status !== '1' || !body.result) return null;
      return JSON.parse(body.result);
    } catch {
      return null; // unverified, rate-limited, or explorer down — fall back.
    } finally {
      abiInflight.delete(cacheKey);
    }
  })();

  abiInflight.set(cacheKey, load);
  const abi = await load;
  abiCache.set(cacheKey, { value: abi, expiresAt: Date.now() + ABI_CACHE_TTL_MS });
  return abi;
}

function clearAbiCache() {
  abiCache.clear();
  abiInflight.clear();
}

function getAbiCacheSize() {
  return abiCache.size;
}

function getAbiInflightSize() {
  return abiInflight.size;
}
/**
 * Extract usable payable mint entrypoints from a real ABI, if we got one.
 * Returns candidates in the same shape as CANDIDATE_MINT_FUNCTIONS.
 */
function candidatesFromAbi(abi) {
  if (!Array.isArray(abi)) return [];
  const iface = new Interface(abi);
  const out = [];
  for (const fn of iface.fragments) {
    if (fn.type !== 'function') continue;
    if (fn.payable === false && fn.stateMutability !== 'payable') continue;
    if (!/^(mint|claim|publicMint|mintPublic|purchase)$/i.test(fn.name)) continue;
    const types = fn.inputs.map((i) => i.type);
    const name = `${fn.name}(${types.join(',')})`;
    let args = null;
    if (types.length === 0) args = () => [];
    else if (types.length === 1 && /^uint\d*$/.test(types[0])) args = ({ qty }) => [BigInt(qty)];
    else if (types.length === 2 && types[0] === 'address' && /^uint\d*$/.test(types[1]))
      args = ({ qty, minter }) => [minter, BigInt(qty)];
    if (!args) continue; // signature we don't know how to fill — skip it.
    out.push({
      signature: fn.format('full'),
      name,
      args,
      singleUnitOnly: types.length === 0,
      fromVerifiedAbi: true,
    });
  }
  return out;
}

/**
 * Probe candidates against the live chain and return the first that succeeds.
 *
 * A candidate "succeeds" when eth_call does not revert AND estimateGas returns.
 * We collect every failure so that if all of them fail we can hand the user a
 * real diagnosis instead of "mint failed".
 *
 * @throws {MintProbeError} if no candidate is callable.
 */
async function probeMintFunction({
  provider,
  contract,
  minter,
  qty,
  valueWei,
  explorerApi,
  logger = console,
}) {
  const abi = await resolveAbi(contract, { explorerApi });
  const fromAbi = candidatesFromAbi(abi);
  const usedVerifiedAbi = fromAbi.length > 0;

  // Verified-ABI candidates first (highest confidence), then generic fallbacks.
  // De-dupe by name so a verified mint(uint256) isn't probed twice.
  const seen = new Set();
  const candidates = [...fromAbi, ...CANDIDATE_MINT_FUNCTIONS].filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  logger.info?.(
    `[erc721Mint] probing ${contract}: ${candidates.length} candidate(s), ` +
      `verified ABI: ${usedVerifiedAbi ? 'yes' : 'NO (generic selector fallback)'}`
  );

  const failures = [];
  for (const candidate of candidates) {
    let encoded;
    try {
      encoded = encodeCandidate(candidate, { qty, minter });
    } catch (err) {
      failures.push({ candidate: candidate.name, stage: 'encode', reason: err.shortMessage || err.message });
      continue;
    }

    const txReq = { to: contract, from: minter, data: encoded.data, value: valueWei };

    try {
      await provider.call(txReq); // free, off-chain simulation
    } catch (err) {
      failures.push({
        candidate: candidate.name,
        stage: 'eth_call',
        reason: decodeRevert(err),
      });
      continue;
    }

    let gasLimit;
    try {
      gasLimit = await provider.estimateGas(txReq);
    } catch (err) {
      failures.push({
        candidate: candidate.name,
        stage: 'estimateGas',
        reason: decodeRevert(err),
      });
      continue;
    }

    logger.info?.(
      `[erc721Mint] selected ${candidate.name} (gas ~${gasLimit}) ` +
        `${candidate.fromVerifiedAbi ? 'from verified ABI' : 'via generic fallback'}`
    );

    return {
      data: encoded.data,
      selector: encoded.data.slice(0, 10),
      functionName: candidate.name,
      gasLimit,
      singleUnitOnly: Boolean(candidate.singleUnitOnly),
      usedVerifiedAbi: Boolean(candidate.fromVerifiedAbi),
    };
  }

  // FAIL LOUDLY (spec §2). Nothing was signed, nothing was broadcast, no gas spent.
  throw new MintProbeError(contract, failures, usedVerifiedAbi);
}

/**
 * Pull a human-readable revert reason out of an ethers error where possible.
 * Also distinguishes "the contract rejected us" from "the RPC is flaky", because
 * the executor treats those very differently (spec §2: RPC errors are normal).
 */
function decodeRevert(err) {
  if (err?.code === 'CALL_EXCEPTION') {
    if (err.reason) return `revert: ${err.reason}`;
    if (err.data && err.data !== '0x') return `revert (raw ${String(err.data).slice(0, 42)})`;
    return 'revert (no reason string)';
  }
  if (err?.code === 'INSUFFICIENT_FUNDS') return 'insufficient funds for value + gas';
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(err?.code)) {
    return `RPC_ERROR: ${err.shortMessage || err.message}`;
  }
  return err?.shortMessage || err?.message || String(err);
}

class MintProbeError extends Error {
  constructor(contract, failures, usedVerifiedAbi) {
    const rpcOnly = failures.length > 0 && failures.every((f) => f.reason.startsWith('RPC_ERROR'));
    const detail = failures.map((f) => `  - ${f.candidate} [${f.stage}] ${f.reason}`).join('\n');
    super(
      `No callable mint entrypoint found on ${contract}.\n` +
        `Verified ABI: ${usedVerifiedAbi ? 'yes' : 'no (generic selectors only)'}\n` +
        `${rpcOnly ? 'All probes failed on RPC errors — this may be RPC flakiness, not a bad contract.\n' : ''}` +
        `Tried:\n${detail}`
    );
    this.name = 'MintProbeError';
    this.contract = contract;
    this.failures = failures;
    this.usedVerifiedAbi = usedVerifiedAbi;
    /** true => retrying later may help; false => the contract genuinely rejects us */
    this.retryable = rpcOnly;
  }
}

module.exports = {
  ABI_CACHE_TTL_MS,
  CANDIDATE_MINT_FUNCTIONS,
  GENERIC_MINT_SELECTORS,
  MintProbeError,
  candidatesFromAbi,
  clearAbiCache,
  decodeRevert,
  encodeCandidate,
  getAbiCacheSize,
  getAbiInflightSize,
  probeMintFunction,
  resolveAbi,
  selectorOf,
};
