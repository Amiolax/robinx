'use strict';

/**
 * models.js — data access for User, Wallet, Target, Execution (spec §3).
 *
 * Thin query layer, no ORM. Two conventions worth knowing:
 *
 *  - All wei/lamport amounts are stored as decimal STRINGS and returned as
 *    BigInt. SQLite INTEGER is 64-bit signed and 1 ETH of wei (1e18) fits, but
 *    a fee budget in the tens of ETH plus JS's Number coercion in the driver is
 *    a precision landmine. Strings in, BigInt out, no float ever touches money.
 *  - Timestamps are epoch milliseconds UTC.
 */

const db = require('./db');

const now = () => Date.now();
const toBig = (v) => (v === null || v === undefined || v === '' ? null : BigInt(v));
const fromBig = (v) => (v === null || v === undefined ? null : String(v));

/* ---------------------------------------------------------------- User ---- */

const Users = {
  upsert(telegramId) {
    const id = String(telegramId);
    db.get()
      .prepare('INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, now());
    return this.find(id);
  },
  find(telegramId) {
    return db.get().prepare('SELECT * FROM users WHERE id = ?').get(String(telegramId)) || null;
  },
};

/* -------------------------------------------------------------- Wallet ---- */

const Wallets = {
  /** @param chain 'solana' | 'evm' (the EVM wallet serves every EVM network) */
  create({ userId, chain, address, encryptedPrivkey, encryptionIv }) {
    db.get()
      .prepare(
        `INSERT INTO wallets (user_id, chain, address, encrypted_privkey, encryption_iv, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(String(userId), chain, address, encryptedPrivkey, encryptionIv, now());
    return this.find(userId, chain);
  },
  find(userId, chain) {
    return (
      db.get().prepare('SELECT * FROM wallets WHERE user_id = ? AND chain = ?').get(String(userId), chain) ||
      null
    );
  },
  listForUser(userId) {
    return db.get().prepare('SELECT * FROM wallets WHERE user_id = ?').all(String(userId));
  },
};

/* -------------------------------------------------------------- Target ---- */

const TargetStatus = {
  PENDING: 'pending',
  ARMED: 'armed',
  FIRING: 'firing',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const Targets = {
  create({
    userId,
    sourceUrl,
    platform,
    chain,
    contractOrProgram = null,
    collectionName = null,
    mintPrice = null,
    mintStartAt = null,
    qty = 1,
    maxFeeBudget = null,
    resolverMeta = null,
  }) {
    const ts = now();
    const info = db
      .get()
      .prepare(
        `INSERT INTO targets
           (user_id, source_url, platform, chain, contract_or_program, collection_name,
            mint_price, mint_start_at, qty, max_fee_budget, status, resolver_meta,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        String(userId),
        sourceUrl,
        platform,
        chain,
        contractOrProgram,
        collectionName,
        fromBig(mintPrice),
        mintStartAt,
        qty,
        fromBig(maxFeeBudget),
        TargetStatus.PENDING,
        resolverMeta ? JSON.stringify(resolverMeta) : null,
        ts,
        ts
      );
    return this.find(info.lastInsertRowid);
  },

  find(id) {
    const row = db.get().prepare('SELECT * FROM targets WHERE id = ?').get(id);
    return row ? this._hydrate(row) : null;
  },

  /** Scoped by user so one user can never /arm or /disarm another's target. */
  findForUser(id, userId) {
    const row = db.get().prepare('SELECT * FROM targets WHERE id = ? AND user_id = ?').get(id, String(userId));
    return row ? this._hydrate(row) : null;
  },

  listForUser(userId, statuses = null) {
    let rows;
    if (statuses && statuses.length) {
      const marks = statuses.map(() => '?').join(',');
      rows = db
        .get()
        .prepare(
          `SELECT * FROM targets WHERE user_id = ? AND status IN (${marks}) ORDER BY mint_start_at IS NULL, mint_start_at ASC`
        )
        .all(String(userId), ...statuses);
    } else {
      rows = db
        .get()
        .prepare('SELECT * FROM targets WHERE user_id = ? ORDER BY created_at DESC')
        .all(String(userId));
    }
    return rows.map((r) => this._hydrate(r));
  },

  /** Used on boot to re-arm anything that survived a restart. */
  listArmed() {
    return db
      .get()
      .prepare(`SELECT * FROM targets WHERE status IN ('armed','firing') ORDER BY mint_start_at ASC`)
      .all()
      .map((r) => this._hydrate(r));
  },

  countArmedForUser(userId) {
    return db
      .get()
      .prepare(`SELECT COUNT(*) AS n FROM targets WHERE user_id = ? AND status IN ('armed','firing')`)
      .get(String(userId)).n;
  },

  update(id, fields) {
    const map = {
      contractOrProgram: 'contract_or_program',
      collectionName: 'collection_name',
      mintPrice: 'mint_price',
      mintStartAt: 'mint_start_at',
      qty: 'qty',
      maxFeeBudget: 'max_fee_budget',
      status: 'status',
      chain: 'chain',
      resolverMeta: 'resolver_meta',
    };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      if (k === 'mintPrice' || k === 'maxFeeBudget') vals.push(fromBig(v));
      else if (k === 'resolverMeta') vals.push(v ? JSON.stringify(v) : null);
      else vals.push(v);
    }
    if (!sets.length) return this.find(id);
    sets.push('updated_at = ?');
    vals.push(now(), id);
    db.get()
      .prepare(`UPDATE targets SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals);
    return this.find(id);
  },

  setStatus(id, status) {
    return this.update(id, { status });
  },

  _hydrate(row) {
    return {
      ...row,
      mint_price: toBig(row.mint_price),
      max_fee_budget: toBig(row.max_fee_budget),
      resolver_meta: row.resolver_meta ? JSON.parse(row.resolver_meta) : null,
    };
  },
};

/* ----------------------------------------------------------- Execution ---- */

const Executions = {
  record({ targetId, attemptN, txHash = null, status, errorMessage = null }) {
    // Truncate: error strings can carry a full ABI dump / raw revert blob.
    const msg = errorMessage ? String(errorMessage).slice(0, 2000) : null;
    const info = db
      .get()
      .prepare(
        `INSERT INTO executions (target_id, attempt_n, tx_hash, status, error_message, fired_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(targetId, attemptN, txHash, status, msg, now());
    return info.lastInsertRowid;
  },
  listForTarget(targetId) {
    return db
      .get()
      .prepare('SELECT * FROM executions WHERE target_id = ? ORDER BY attempt_n ASC')
      .all(targetId);
  },
  lastForTarget(targetId) {
    return (
      db
        .get()
        .prepare('SELECT * FROM executions WHERE target_id = ? ORDER BY id DESC LIMIT 1')
        .get(targetId) || null
    );
  },
};

/* ---------------------------------------------------------- RateLimits ---- */

/** spec §7: per-user rate limits on /newtarget and withdrawals. */
const RateLimits = {
  /** @returns {{allowed: boolean, used: number, limit: number, retryAfterMs: number}} */
  check(userId, action, limit, windowMs = 3_600_000) {
    const since = now() - windowMs;
    const uid = String(userId);
    db.get().prepare('DELETE FROM rate_events WHERE created_at < ?').run(now() - 86_400_000);
    const { n } = db
      .get()
      .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE user_id = ? AND action = ? AND created_at >= ?')
      .get(uid, action, since);

    if (n >= limit) {
      const oldest = db
        .get()
        .prepare(
          'SELECT MIN(created_at) AS t FROM rate_events WHERE user_id = ? AND action = ? AND created_at >= ?'
        )
        .get(uid, action, since);
      return {
        allowed: false,
        used: n,
        limit,
        retryAfterMs: Math.max(0, (oldest?.t ?? now()) + windowMs - now()),
      };
    }
    return { allowed: true, used: n, limit, retryAfterMs: 0 };
  },

  /** Call only after the action actually succeeded. */
  record(userId, action) {
    db.get()
      .prepare('INSERT INTO rate_events (user_id, action, created_at) VALUES (?,?,?)')
      .run(String(userId), action, now());
  },
};

module.exports = { Executions, RateLimits, TargetStatus, Targets, Users, Wallets };
