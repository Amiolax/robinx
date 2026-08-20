'use strict';

/**
 * executor.js — EVM send path: pre-warm, pre-build, fire, gas-bump retry.
 *
 * Primary target: Robinhood Chain (Arbitrum Orbit L2). Same code path serves any
 * EVM network defined in config/default.json.
 *
 * Design points that come straight out of the spec:
 *
 *  §5 pre-warm   -> preWarm() opens every configured RPC, races them, keeps a
 *                   keep-alive poll running so sockets/TLS are hot at T=0.
 *  §5 pre-build  -> buildTemplate() does ALL expensive work (ABI probe, gas
 *                   estimate, nonce fetch) ahead of time. fire() only fills in
 *                   fees + nonce and signs.
 *  §5 fire       -> we do NOT await confirmation before re-broadcasting. A
 *                   watcher runs concurrently; the send loop keeps bumping.
 *  §2 RPC churn  -> every call goes through withFailover(), which rotates
 *                   endpoints on transport errors. RPC failure is normal here.
 *  §2 fail loud  -> a revert stops the run immediately with the decoded reason,
 *                   rather than re-sending into the same revert.
 */

const { JsonRpcProvider, Wallet, FetchRequest } = require('ethers');
const { probeMintFunction, MintProbeError, decodeRevert } = require('./erc721Mint');
const retryPolicy = require('../../scheduler/retryPolicy');
const { ErrorClass, classifyError } = retryPolicy;

/**
 * Holds one or more providers for a network and rotates away from unhealthy ones.
 * Robinhood Chain's public RPC is new; assume any single endpoint can vanish
 * mid-mint and make that a non-event.
 */
class ProviderPool {
  constructor(network, { logger = console } = {}) {
    if (!network || !Array.isArray(network.rpcUrls) || network.rpcUrls.length === 0) {
      throw new Error(`network config missing rpcUrls (network: ${network?.name || 'unknown'})`);
    }
    this.network = network;
    this.logger = logger;
    this.idx = 0;
    this.providers = network.rpcUrls.map((url) => {
      // staticNetwork: skip the eth_chainId round-trip on every call — saves
      // latency at fire time and avoids spurious "network changed" errors.
      const req = new FetchRequest(url);
      req.timeout = network.rpcTimeoutMs ?? 8000;
      return {
        url,
        provider: new JsonRpcProvider(req, network.chainId, {
          staticNetwork: true,
          batchMaxCount: 1, // don't let batching delay a time-critical send
          polling: true,
          pollingInterval: network.pollingIntervalMs ?? 250,
        }),
        healthy: true,
        failures: 0,
      };
    });
    this._keepAlive = null;
  }

  current() {
    // Prefer a healthy endpoint; if all are marked bad, use whatever's next
    // (they may have recovered — better to try than to give up).
    for (let i = 0; i < this.providers.length; i++) {
      const e = this.providers[(this.idx + i) % this.providers.length];
      if (e.healthy) {
        this.idx = (this.idx + i) % this.providers.length;
        return e;
      }
    }
    this.idx = (this.idx + 1) % this.providers.length;
    return this.providers[this.idx];
  }

  rotate(reason) {
    const prev = this.providers[this.idx];
    prev.failures += 1;
    if (prev.failures >= 2) prev.healthy = false;
    this.idx = (this.idx + 1) % this.providers.length;
    this.logger.warn?.(
      `[evm] rotating RPC away from ${redact(prev.url)} (${reason}) -> ${redact(this.providers[this.idx].url)}`
    );
  }

  markHealthy() {
    const e = this.providers[this.idx];
    e.failures = 0;
    e.healthy = true;
  }

  /**
   * Run `fn(provider)` against the pool, rotating on transport errors.
   * Contract-level errors (reverts) are rethrown immediately — rotating won't
   * change a revert, and retrying it would be exactly the "silently burn gas"
   * behaviour the spec calls out.
   */
  async withFailover(fn, { attempts = null, label = 'rpc' } = {}) {
    const max = attempts ?? this.providers.length * 2;
    let lastErr;
    for (let i = 0; i < max; i++) {
      const entry = this.current();
      try {
        const out = await fn(entry.provider);
        this.markHealthy();
        return out;
      } catch (err) {
        lastErr = err;
        const cls = classifyError(err);
        if (cls !== ErrorClass.RPC) throw err; // not a transport problem
        this.logger.warn?.(`[evm] ${label} failed on ${redact(entry.url)}: ${err.shortMessage || err.message}`);
        this.rotate(cls);
      }
    }
    const e = new Error(
      `all RPC endpoints failed for ${label} on ${this.network.name}: ${lastErr?.shortMessage || lastErr?.message}`
    );
    e.code = 'RPC_POOL_EXHAUSTED';
    e.cause = lastErr;
    throw e;
  }

  /** Keep sockets warm so T=0 doesn't pay TLS/DNS setup cost (spec §5). */
  startKeepAlive(intervalMs = 3000) {
    if (this._keepAlive) return;
    const tick = async () => {
      await Promise.allSettled(
        this.providers.map(async (e) => {
          try {
            await e.provider.getBlockNumber();
            e.healthy = true;
            e.failures = 0;
          } catch {
            e.failures += 1;
            if (e.failures >= 2) e.healthy = false;
          }
        })
      );
    };
    tick();
    this._keepAlive = setInterval(tick, intervalMs);
    if (this._keepAlive.unref) this._keepAlive.unref();
  }

  stopKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  destroy() {
    this.stopKeepAlive();
    for (const e of this.providers) {
      try {
        e.provider.destroy();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Never log full RPC URLs — they often embed an API key. */
function redact(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 12 ? `${u.pathname.slice(0, 8)}…` : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '<rpc>';
  }
}

/**
 * PRE-WARM (T-30s). Opens connections, verifies chain id, and starts keep-alive.
 * Returns the pool so the caller can hand it to buildTemplate()/fire().
 */
async function preWarm({ network, logger = console }) {
  const pool = new ProviderPool(network, { logger });
  pool.startKeepAlive(network.keepAliveIntervalMs ?? 3000);

  const observed = await pool.withFailover(
    async (p) => {
      const net = await p.getNetwork();
      return Number(net.chainId);
    },
    { label: 'getNetwork' }
  );

  if (network.chainId && observed !== Number(network.chainId)) {
    pool.destroy();
    throw new Error(
      `chain id mismatch on ${network.name}: config says ${network.chainId}, RPC reports ${observed}. ` +
        `Refusing to proceed — signing for the wrong chain risks replay/loss.`
    );
  }

  const blockNumber = await pool.withFailover((p) => p.getBlockNumber(), { label: 'getBlockNumber' });
  logger.info?.(`[evm] pre-warmed ${network.name} (chainId ${observed}) at block ${blockNumber}`);
  return { pool, chainId: observed, blockNumber };
}

/**
 * PRE-BUILD. Everything slow happens here, during the T-30s window:
 *   - resolve/probe the mint entrypoint (ABI or generic selector fallback)
 *   - gas limit
 *   - nonce
 *   - balance sanity check
 *
 * @throws {MintProbeError} if no mint entrypoint is callable — loudly, pre-flight.
 */
async function buildTemplate({
  pool,
  signerKey,
  contract,
  qty = 1,
  mintPriceWei = 0n,
  maxFeeBudgetWei,
  network,
  logger = console,
}) {
  const wallet = new Wallet(signerKey); // unconnected: signing only, no key on the wire
  const minter = wallet.address;
  const valueWei = BigInt(mintPriceWei) * BigInt(qty);

  const probe = await pool.withFailover(
    (provider) =>
      probeMintFunction({
        provider,
        contract,
        minter,
        qty,
        valueWei,
        explorerApi: network.explorerApi,
        logger,
      }),
    { label: 'probeMintFunction' }
  );

  // qty>1 against a no-arg mint() can't be done in one tx. Surface it rather
  // than silently minting 1 and calling it a win.
  if (probe.singleUnitOnly && qty > 1) {
    logger.warn?.(
      `[evm] ${probe.functionName} takes no quantity arg; qty=${qty} needs ${qty} separate txs. ` +
        `Firing 1 unit this run.`
    );
  }

  const [nonce, balance, feeData] = await Promise.all([
    pool.withFailover((p) => p.getTransactionCount(minter, 'pending'), { label: 'getTransactionCount' }),
    pool.withFailover((p) => p.getBalance(minter), { label: 'getBalance' }),
    pool.withFailover((p) => p.getFeeData(), { label: 'getFeeData' }),
  ]);

  // Pad the estimate: mint gas often rises once public sale opens (allowlist
  // branch, supply bookkeeping). Under-limiting burns gas on out-of-gas revert.
  const gasLimit = (BigInt(probe.gasLimit) * 125n) / 100n;

  const baseFeeWei = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  if (balance < valueWei) {
    throw new Error(
      `insufficient balance on ${network.name}: need ${valueWei} wei for mint value, wallet has ${balance} wei`
    );
  }

  const template = {
    to: contract,
    data: probe.data,
    value: valueWei,
    gasLimit,
    chainId: Number(network.chainId),
    type: 2, // EIP-1559. Orbit chains support it; see note in README.
    nonce,
    // metadata for logging / the confirm card
    _meta: {
      minter,
      functionName: probe.functionName,
      selector: probe.selector,
      usedVerifiedAbi: probe.usedVerifiedAbi,
      singleUnitOnly: probe.singleUnitOnly,
      qty,
      balance,
      baseFeeWei,
      builtAt: Date.now(),
    },
  };

  logger.info?.(
    `[evm] template ready: ${probe.functionName} -> ${contract} value=${valueWei} gas=${gasLimit} nonce=${nonce}`
  );
  return { template, wallet, probe };
}

/**
 * FIRE (T=0) + retry with gas bump.
 *
 * Loop shape (spec §5): send, do NOT await confirmation, sleep a short interval,
 * bump the tip, re-broadcast. A concurrent watcher resolves the moment any of our
 * broadcast hashes confirms.
 *
 * @param onAttempt callback({attempt, txHash, fees, errorClass}) for Execution rows
 * @returns {{success, txHash, attempts, receipt?, reason?}}
 */
async function fire({
  pool,
  wallet,
  template,
  maxFeeBudgetWei,
  policy = {},
  onAttempt = () => {},
  logger = console,
}) {
  const opts = { ...retryPolicy.DEFAULTS, ...policy };
  const startedAt = Date.now();
  const seenHashes = new Set();

  let attempt = 0;
  let budgetedAttempts = 0;
  let lastErrorClass = null;
  let settled = null;

  // --- concurrent confirmation watcher -------------------------------------
  // Resolves as soon as ANY broadcast attempt lands. Runs independently of the
  // send loop so we never block re-broadcast on a confirmation wait.
  const watch = (async () => {
    while (!settled && Date.now() - startedAt < opts.totalTimeoutMs) {
      for (const hash of Array.from(seenHashes)) {
        try {
          const receipt = await pool.withFailover((p) => p.getTransactionReceipt(hash), {
            label: 'getTransactionReceipt',
            attempts: 1,
          });
          if (receipt) {
            if (receipt.status === 1) return { success: true, txHash: hash, receipt };
            // Mined but reverted — terminal. Don't re-send into the same revert.
            return {
              success: false,
              txHash: hash,
              receipt,
              reason: 'transaction mined but reverted (mint rejected on-chain)',
              code: 'reverted',
            };
          }
        } catch {
          /* watcher must never throw the run */
        }
      }
      await sleep(250);
    }
    return null;
  })();

  // --- send loop ------------------------------------------------------------
  const sendLoop = (async () => {
    while (!settled) {
      attempt += 1;

      const feeData = await pool
        .withFailover((p) => p.getFeeData(), { label: 'getFeeData', attempts: 2 })
        .catch(() => ({ maxFeePerGas: template._meta.baseFeeWei, maxPriorityFeePerGas: 0n }));

      const baseFeeWei = feeData.maxFeePerGas ?? feeData.gasPrice ?? template._meta.baseFeeWei ?? 0n;
      const basePriorityFeeWei =
        feeData.maxPriorityFeePerGas ?? BigInt(opts.defaultPriorityFeeWei ?? 100_000_000n);

      const fees = retryPolicy.computeFees({
        attempt: budgetedAttempts + 1,
        baseFeeWei,
        basePriorityFeeWei,
        gasLimit: template.gasLimit,
        maxFeeBudgetWei,
        valueWei: template.value,
        bumpPercent: opts.bumpPercent,
      });

      const stop = retryPolicy.shouldStop({
        attempt: budgetedAttempts + 1,
        startedAt,
        now: Date.now(),
        lastErrorClass,
        feeState: fees,
        opts,
      });
      if (stop) return { success: false, attempts: attempt - 1, reason: stop.reason, code: stop.code };

      const tx = {
        to: template.to,
        data: template.data,
        value: template.value,
        gasLimit: template.gasLimit,
        chainId: template.chainId,
        type: 2,
        nonce: template.nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };

      try {
        // Sign locally, broadcast raw: the key never leaves this process and we
        // can re-broadcast the identical blob to several endpoints if needed.
        const signed = await wallet.signTransaction(tx);
        const hash = await pool.withFailover((p) => p.broadcastTransaction(signed).then((r) => r.hash), {
          label: 'broadcastTransaction',
          attempts: 2,
        });

        seenHashes.add(hash);
        lastErrorClass = null;
        budgetedAttempts += 1;
        logger.info?.(
          `[evm] attempt ${attempt} broadcast ${hash} tip=${fees.maxPriorityFeePerGas} ` +
            `maxFee=${fees.maxFeePerGas}${fees.atBudgetCeiling ? ' (AT BUDGET CEILING)' : ''}`
        );
        onAttempt({ attempt, txHash: hash, fees, errorClass: null });
      } catch (err) {
        const cls = classifyError(err);
        lastErrorClass = cls;
        if (retryPolicy.consumesAttemptBudget(cls)) budgetedAttempts += 1;

        logger.warn?.(`[evm] attempt ${attempt} failed (${cls}): ${err.shortMessage || err.message}`);
        onAttempt({ attempt, txHash: null, fees, errorClass: cls, error: decodeRevert(err) });

        if (cls === ErrorClass.NONCE) {
          // Nonce consumed: either our earlier broadcast landed, or something
          // else used it. Hand off to the watcher rather than blindly bumping.
          if (seenHashes.size > 0) {
            logger.info?.('[evm] nonce consumed — waiting on watcher to confirm an earlier attempt');
            await sleep(1500);
            continue;
          }
          return { success: false, attempts: attempt, reason: 'nonce already used by another tx', code: 'nonce' };
        }

        if (!retryPolicy.isRetryable(cls)) {
          return {
            success: false,
            attempts: attempt,
            reason: `${cls}: ${decodeRevert(err)}`,
            code: cls,
          };
        }
      }

      await sleep(retryPolicy.nextDelayMs(attempt, opts));
    }
    return null;
  })();

  const result = await Promise.race([
    watch.then((r) => (r ? { ...r, attempts: attempt } : null)),
    sendLoop,
  ]);

  settled = result || { success: false, attempts: attempt, reason: 'timeout', code: 'timeout' };

  // Give the watcher a final grace window: a tx broadcast right before the loop
  // gave up may still confirm, and reporting "failed" on a mint that landed is
  // the worst possible outcome for the user.
  if (!settled.success && seenHashes.size > 0 && settled.code !== 'reverted') {
    const grace = await Promise.race([watch, sleep(opts.confirmGraceMs ?? 8000).then(() => null)]);
    if (grace && grace.success) settled = { ...grace, attempts: attempt };
  }

  return { ...settled, attempts: settled.attempts ?? attempt, broadcastHashes: Array.from(seenHashes) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Plain value transfer — used by /withdraw.
 * Leaves the fee out of the swept amount when sending max.
 */
async function sendNative({ pool, signerKey, to, amountWei, network, sweep = false, logger = console }) {
  const wallet = new Wallet(signerKey);
  const from = wallet.address;

  const [nonce, balance, feeData] = await Promise.all([
    pool.withFailover((p) => p.getTransactionCount(from, 'pending'), { label: 'getTransactionCount' }),
    pool.withFailover((p) => p.getBalance(from), { label: 'getBalance' }),
    pool.withFailover((p) => p.getFeeData(), { label: 'getFeeData' }),
  ]);

  const gasLimit = 21000n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 100_000_000n;
  const maxFeePerGas = (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) * 2n + maxPriorityFeePerGas;
  const feeReserve = gasLimit * maxFeePerGas;

  let value = sweep ? balance - feeReserve : BigInt(amountWei);
  if (value <= 0n) {
    throw new Error(
      `nothing to withdraw: balance ${balance} wei does not cover the ${feeReserve} wei fee reserve`
    );
  }
  if (value + feeReserve > balance) {
    throw new Error(
      `insufficient balance: requested ${value} wei + ${feeReserve} wei fees > balance ${balance} wei`
    );
  }

  const signed = await wallet.signTransaction({
    to,
    value,
    gasLimit,
    nonce,
    chainId: Number(network.chainId),
    type: 2,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const hash = await pool.withFailover((p) => p.broadcastTransaction(signed).then((r) => r.hash), {
    label: 'broadcastTransaction(withdraw)',
  });
  logger.info?.(`[evm] withdrawal broadcast ${hash} (${value} wei -> ${to})`);
  return { txHash: hash, value };
}

/**
 * Private-relay / bundle submission hook (spec §5 mentions a Flashbots-style
 * option for EVM).
 *
 * NOT IMPLEMENTED — and deliberately not guessed at. Robinhood Chain is an
 * Arbitrum Orbit rollup with a centralised sequencer, so the public-mempool fee
 * auction that Flashbots exists to bypass does not work the same way here, and I
 * have no confirmed relay endpoint for this chain. Wiring a fake one would give a
 * false sense of protection.
 *
 * To enable later: set network.privateRelay.url in config and implement submit().
 * The executor will pick it up via this seam without touching the retry loop.
 */
async function submitViaPrivateRelay() {
  throw new Error(
    'private relay not configured for this network — see executor.js submitViaPrivateRelay() notes'
  );
}

module.exports = {
  ProviderPool,
  MintProbeError,
  buildTemplate,
  fire,
  preWarm,
  redact,
  sendNative,
  submitViaPrivateRelay,
};
