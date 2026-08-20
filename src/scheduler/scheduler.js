'use strict';

/**
 * scheduler.js — arms targets, fires them at T=0 (spec §5).
 *
 * TIMELINE PER TARGET
 * -------------------
 *   arm()        validate config/wallet/balance NOW, so failures surface while
 *                the user is still in the chat rather than at T=0
 *   T-30s        pre-warm: open + keep-alive RPC connections, then pre-build the
 *                unsigned tx (ABI probe, gas estimate, nonce)
 *   T=0          fire: hand off to the chain executor's retry/bump loop
 *   after        persist Executions, update Target status, DM the user
 *
 * WHY setTimeout AND NOT node-cron
 * --------------------------------
 * Cron's resolution is one second. A mint war is decided inside the first block,
 * so a sub-second offset matters. setTimeout gives ms resolution.
 *
 * The catch is that setTimeout drifts and is capped at ~24.8 days (2^31-1 ms), so
 * long waits are chunked: we sleep in bounded hops and re-check the wall clock
 * each time. That also makes us robust to the process being suspended.
 */

const { setTimeout: sleep } = require('timers/promises');

const evmExecutor = require('../chains/evm/executor');
const solExecutor = require('../chains/solana/executor');
const retryPolicy = require('./retryPolicy');
const walletManager = require('../wallets/walletManager');
const db = require('../store/db');
const { Executions, Targets, TargetStatus } = require('../store/models');

const MAX_TIMEOUT_MS = 2_000_000_000; // safely under setTimeout's 2^31-1 cap
const FINAL_HOP_MS = 5_000; // switch to precise mode inside this window

class Scheduler {
  /**
   * @param notify async (userId, message) => void — injected so the scheduler
   *        never imports Telegraf (keeps it unit-testable headless).
   */
  constructor({ config, notify, logger = console }) {
    this.config = config;
    this.notify = notify || (async () => {});
    this.logger = logger;
    /** targetId -> { cancelled, pool, phase } */
    this.active = new Map();
  }

  /** Re-arm anything still armed after a restart (spec §5 durability). */
  async resumeAll() {
    const rows = Targets.listArmed();
    this.logger.info?.(`[scheduler] resuming ${rows.length} armed target(s)`);
    for (const t of rows) {
      // A target whose mint time passed while we were down can't be sniped.
      // Marking it failed with a clear reason beats silently firing late.
      if (t.mint_start_at && t.mint_start_at + 60_000 < Date.now()) {
        Targets.setStatus(t.id, TargetStatus.FAILED);
        Executions.record({
          targetId: t.id,
          attemptN: 0,
          status: 'failed',
          errorMessage: 'missed mint window: bot was offline at mint_start_at',
        });
        await this.notify(
          t.user_id,
          `Target #${t.id} was missed — the bot was offline at its mint time. Not fired.`
        );
        continue;
      }
      this.arm(t.id).catch((e) => this.logger.error?.(`[scheduler] resume ${t.id} failed: ${e.message}`));
    }
  }

  /**
   * Validate + schedule a target. Everything checkable is checked HERE, not at
   * T=0: unknown network, placeholder config, missing wallet, unfunded wallet.
   */
  async arm(targetId) {
    const target = Targets.find(targetId);
    if (!target) throw new Error(`target ${targetId} not found`);

    const network = this.config.networks?.[target.chain];
    if (!network) throw new Error(`unknown network "${target.chain}" — check config/default.json`);

    // Hard gate on REQUIRED_FILL_ME placeholders (wrong chainId => lost funds).
    db.assertNetworkUsable(network);

    if (network.kind !== 'evm') {
      throw new Error(
        `${network.displayName || target.chain} execution is not implemented yet ` +
          `(only EVM networks are wired). See README.`
      );
    }
    if (!target.mint_start_at) {
      throw new Error(
        'this target has no mint start time — cannot schedule. ' +
          'Set one explicitly before arming.'
      );
    }

    const horizon = this.config.scheduler?.maxScheduleHorizonMs ?? 2_592_000_000;
    const delta = target.mint_start_at - Date.now();
    if (delta > horizon) {
      throw new Error(`mint time is more than ${Math.round(horizon / 86_400_000)} days out — too far to arm`);
    }

    if (this.active.has(targetId)) {
      this.logger.warn?.(`[scheduler] target ${targetId} already armed; re-arming`);
      this.disarm(targetId);
    }

    Targets.setStatus(targetId, TargetStatus.ARMED);
    const state = { cancelled: false, pool: null, phase: 'armed' };
    this.active.set(targetId, state);

    this._run(targetId, state).catch(async (err) => {
      this.logger.error?.(`[scheduler] target ${targetId} crashed: ${err.stack || err.message}`);
      Targets.setStatus(targetId, TargetStatus.FAILED);
      Executions.record({
        targetId,
        attemptN: 0,
        status: 'failed',
        errorMessage: err.message,
      });
      await this._safeNotify(targetId, `Target #${targetId} failed: ${err.message}`);
      this._cleanup(targetId);
    });

    const preWarmLead = this.config.scheduler?.preWarmLeadMs ?? retryPolicy.DEFAULTS.preWarmLeadMs;
    return {
      armed: true,
      firesInMs: delta,
      preWarmsInMs: Math.max(0, delta - preWarmLead),
    };
  }

  /** Cancel a target. Only meaningful before it starts broadcasting. */
  disarm(targetId) {
    const state = this.active.get(targetId);
    if (state) {
      state.cancelled = true;
      if (state.pool) state.pool.destroy();
      this.active.delete(targetId);
    }
    const t = Targets.find(targetId);
    // Don't rewrite a terminal status; firing is past the point of no return.
    if (t && [TargetStatus.ARMED, TargetStatus.PENDING].includes(t.status)) {
      Targets.setStatus(targetId, TargetStatus.CANCELLED);
    }
    return { disarmed: Boolean(state), wasFiring: state?.phase === 'firing' };
  }

  /** True if this target is mid-broadcast (so /disarm can warn the user). */
  isFiring(targetId) {
    return this.active.get(targetId)?.phase === 'firing';
  }

  /**
   * Sleep until `deadline`, in bounded hops, aborting if cancelled.
   * Re-reads Date.now() every hop so suspend/resume or clock adjustment can't
   * leave us sleeping past the mint.
   */
  async _sleepUntil(deadline, state) {
    for (;;) {
      if (state.cancelled) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      // Inside the final window, poll tightly for ms-accurate wake-up.
      const hop = remaining > FINAL_HOP_MS ? Math.min(remaining - FINAL_HOP_MS, MAX_TIMEOUT_MS) : 25;
      await sleep(hop);
    }
  }

  async _run(targetId, state) {
    const target = Targets.find(targetId);
    const network = this.config.networks[target.chain];
    const preWarmLead = this.config.scheduler?.preWarmLeadMs ?? retryPolicy.DEFAULTS.preWarmLeadMs;
    const fireAt = target.mint_start_at;

    // ---------- wait until T-30s ----------
    if (!(await this._sleepUntil(fireAt - preWarmLead, state))) return this._cleanup(targetId);

    // ---------- T-30s: PRE-WARM + PRE-BUILD ----------
    state.phase = 'prewarm';
    this.logger.info?.(`[scheduler] target ${targetId}: pre-warming ${network.name}`);

    const { pool } = await evmExecutor.preWarm({ network, logger: this.logger });
    state.pool = pool;

    let built;
    try {
      built = await walletManager.withEvmKey(target.user_id, (privkey) =>
        evmExecutor.buildTemplate({
          pool,
          signerKey: privkey,
          contract: target.contract_or_program,
          qty: target.qty,
          mintPriceWei: target.mint_price ?? 0n,
          maxFeeBudgetWei: target.max_fee_budget ?? 0n,
          network,
          logger: this.logger,
        })
      );
    } catch (err) {
      // FAIL LOUDLY, PRE-FLIGHT (spec §2). Nothing signed, no gas spent.
      Targets.setStatus(targetId, TargetStatus.FAILED);
      Executions.record({
        targetId,
        attemptN: 0,
        status: 'failed',
        errorMessage: `pre-build failed: ${err.message}`,
      });
      await this._safeNotify(
        targetId,
        `Target #${targetId} aborted at pre-flight — nothing was sent, no gas spent.\n\n` +
          `${err.message}\n\n` +
          (err.name === 'MintProbeError'
            ? 'The contract did not accept any known mint()/claim() call. It may not be live yet, ' +
              'may be allowlist-only, or may use a custom mint function.'
            : '')
      );
      return this._cleanup(targetId);
    }

    if (state.cancelled) return this._cleanup(targetId);

    await this._safeNotify(
      targetId,
      `Target #${targetId} pre-warmed and ready.\n` +
        `Function: ${built.template._meta.functionName}` +
        `${built.template._meta.usedVerifiedAbi ? '' : ' (generic fallback — ABI unverified)'}\n` +
        `Firing in ${Math.max(0, Math.round((fireAt - Date.now()) / 1000))}s.`
    );

    // ---------- wait until T=0 ----------
    if (!(await this._sleepUntil(fireAt, state))) return this._cleanup(targetId);

    // ---------- T=0: FIRE ----------
    state.phase = 'firing';
    Targets.setStatus(targetId, TargetStatus.FIRING);
    this.logger.info?.(`[scheduler] target ${targetId}: FIRING`);

    const result = await evmExecutor.fire({
      pool,
      wallet: built.wallet,
      template: built.template,
      maxFeeBudgetWei: target.max_fee_budget ?? 0n,
      policy: { ...(network.policy || {}) },
      logger: this.logger,
      onAttempt: ({ attempt, txHash, errorClass, error }) => {
        Executions.record({
          targetId,
          attemptN: attempt,
          txHash,
          status: txHash ? 'broadcast' : 'failed',
          errorMessage: errorClass ? `${errorClass}: ${error || ''}` : null,
        });
      },
    });

    // ---------- report ----------
    const explorer = network.blockExplorerTxUrl;
    const txLink =
      result.txHash && explorer && !/REQUIRED_FILL_ME/.test(explorer)
        ? `${explorer}${result.txHash}`
        : result.txHash || null;

    if (result.success) {
      Targets.setStatus(targetId, TargetStatus.DONE);
      Executions.record({
        targetId,
        attemptN: result.attempts ?? 0,
        txHash: result.txHash,
        status: 'confirmed',
      });
      await this._safeNotify(
        targetId,
        `MINTED — target #${targetId} confirmed after ${result.attempts} attempt(s).\n` +
          (txLink ? `\n${txLink}` : `\ntx: ${result.txHash}`)
      );
    } else {
      Targets.setStatus(targetId, TargetStatus.FAILED);
      Executions.record({
        targetId,
        attemptN: result.attempts ?? 0,
        txHash: result.txHash || null,
        status: 'failed',
        errorMessage: result.reason,
      });
      await this._safeNotify(
        targetId,
        `Target #${targetId} did not mint.\n\nReason: ${result.reason}\n` +
          `Attempts: ${result.attempts}\n` +
          (txLink ? `\nLast tx: ${txLink}` : '') +
          (result.code === 'budget'
            ? '\n\nYour fee budget was too low for the gas price at mint time.'
            : '') +
          (result.code === 'reverted'
            ? '\n\nThe transaction was included but reverted — likely sold out, not live, or allowlist-only.'
            : '')
      );
    }

    this._cleanup(targetId);
  }

  async _safeNotify(targetId, message) {
    try {
      const t = Targets.find(targetId);
      if (t) await this.notify(t.user_id, message);
    } catch (err) {
      // A blocked bot / closed chat must never break the fire path.
      this.logger.warn?.(`[scheduler] notify failed for ${targetId}: ${err.message}`);
    }
  }

  _cleanup(targetId) {
    const state = this.active.get(targetId);
    if (state?.pool) state.pool.destroy();
    this.active.delete(targetId);
  }

  shutdown() {
    for (const id of Array.from(this.active.keys())) this._cleanup(id);
  }
}

module.exports = { FINAL_HOP_MS, Scheduler };
