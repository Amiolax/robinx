'use strict';

/**
 * db.js — SQLite client + schema (spec §3).
 *
 * better-sqlite3: synchronous, which is exactly what we want here. At T=0 we
 * cannot afford to yield the event loop to an async DB driver while a mint is
 * being broadcast — sync writes are microseconds and keep the fire path clean.
 *
 * WAL mode so the scheduler writing Execution rows never blocks the bot thread
 * reading Targets.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- telegram user id
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain             TEXT NOT NULL CHECK (chain IN ('solana','evm')),
  address           TEXT NOT NULL,
  encrypted_privkey TEXT NOT NULL,       -- "v1:<b64 authTag>:<b64 ciphertext>"
  encryption_iv     TEXT NOT NULL,       -- base64 iv
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, chain)           -- one hot wallet per user per chain (spec 7)
);

CREATE TABLE IF NOT EXISTS targets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Nullable: /manualtarget creates a target from a chain + contract address
  -- with no marketplace link at all. That path is the fallback for when a
  -- resolver is down, rate-limited, or not yet enabled, so it must not be
  -- blocked by a NOT NULL here.
  source_url          TEXT,
  -- 'manual' is a first-class platform, not an edge case — see source_url above.
  platform            TEXT NOT NULL CHECK (platform IN ('opensea','magiceden','rarible','manual')),

  chain               TEXT NOT NULL,     -- network key from config.networks
  contract_or_program TEXT,
  collection_name     TEXT,
  mint_price          TEXT,              -- wei/lamports as decimal STRING (BigInt-safe)
  mint_start_at       INTEGER,           -- epoch ms UTC
  qty                 INTEGER NOT NULL DEFAULT 1,
  max_fee_budget      TEXT,              -- wei/lamports as decimal STRING
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','armed','firing','done','failed','cancelled')),
  resolver_meta       TEXT,              -- raw resolver JSON, for debugging
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_targets_user   ON targets(user_id);
CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status, mint_start_at);

CREATE TABLE IF NOT EXISTS executions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id     INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  attempt_n     INTEGER NOT NULL,
  tx_hash       TEXT,
  status        TEXT NOT NULL,           -- 'broadcast' | 'confirmed' | 'failed'
  error_message TEXT,
  fired_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_target ON executions(target_id);

-- Not in the spec's data model, but spec 7 requires per-user rate limiting on
-- /newtarget and withdrawals, and that has to survive a restart to mean anything.
CREATE TABLE IF NOT EXISTS rate_events (
  user_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(user_id, action, created_at);
`;

let db = null;

function init(dbPath = './data/sniper.db') {
  if (db) return db;
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  db = new Database(dbPath);
  db.exec(SCHEMA);
  migrate(db);


  // The DB holds encrypted key material — never world-readable.
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    /* best effort; non-POSIX fs */
  }
  return db;
}

/**
 * Bring an EXISTING database up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so schema changes reach existing installs only through here. The
 * change that needs it: `targets.source_url` was NOT NULL and `platform`'s CHECK
 * did not include 'manual', which made /manualtarget fail with a raw SQLite
 * constraint error on any database created before this version.
 *
 * SQLite cannot ALTER away a NOT NULL or widen a CHECK, so the table is rebuilt
 * — the documented 12-step procedure, in a transaction, with foreign keys off so
 * the child `executions` rows survive the swap. Guarded by a probe so it runs at
 * most once.
 */
function migrate(conn) {
  const cols = conn.prepare(`PRAGMA table_info(targets)`).all();
  if (!cols.length) return; // fresh DB — SCHEMA already created it correctly

  const sourceUrl = cols.find((c) => c.name === 'source_url');
  const tableSql =
    conn.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='targets'`).get()?.sql || '';

  const needsRebuild = Boolean(sourceUrl?.notnull) || !/'manual'/.test(tableSql);
  if (!needsRebuild) return;

  // Must be OUTSIDE the transaction: this pragma is a no-op mid-transaction.
  conn.pragma('foreign_keys = OFF');
  try {
    conn.transaction(() => {
      conn.exec(`
        CREATE TABLE targets_migrated (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_url          TEXT,
          platform            TEXT NOT NULL
                              CHECK (platform IN ('opensea','magiceden','rarible','manual')),
          chain               TEXT NOT NULL,
          contract_or_program TEXT,
          collection_name     TEXT,
          mint_price          TEXT,
          mint_start_at       INTEGER,
          qty                 INTEGER NOT NULL DEFAULT 1,
          max_fee_budget      TEXT,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','armed','firing','done','failed','cancelled')),
          resolver_meta       TEXT,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL
        );
        INSERT INTO targets_migrated
          SELECT id, user_id, source_url, platform, chain, contract_or_program,
                 collection_name, mint_price, mint_start_at, qty, max_fee_budget,
                 status, resolver_meta, created_at, updated_at
          FROM targets;
        DROP TABLE targets;
        ALTER TABLE targets_migrated RENAME TO targets;
        CREATE INDEX IF NOT EXISTS idx_targets_user   ON targets(user_id);
        CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status, mint_start_at);
      `);
    })();

    // A rebuild that silently orphaned executions rows would be worse than the
    // bug being fixed, so verify before trusting the result.
    const orphans = conn
      .prepare(`SELECT COUNT(*) AS n FROM executions WHERE target_id NOT IN (SELECT id FROM targets)`)
      .get().n;
    if (orphans > 0) throw new Error(`migration left ${orphans} orphaned execution row(s)`);
  } finally {
    conn.pragma('foreign_keys = ON');
  }
}

function get() {
  if (!db) throw new Error('db not initialised — call init() first');
  return db;
}


function close() {
  if (db) db.close();
  db = null;
}

/**
 * Load config/default.json and overlay env.
 *
 * Placeholders are NOT resolved silently: assertNetworkUsable() throws before
 * anything gets signed. Better a startup error than a tx on the wrong chain.
 */
function loadConfig(configPath = path.join(__dirname, '..', '..', 'config', 'default.json')) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  for (const [key, net] of Object.entries(cfg.networks || {})) {
    net.name = net.name || key;
    // Env override: SNIPER_RPC_ROBINHOOD="https://a,https://b"
    const envRpc = process.env[`SNIPER_RPC_${key.toUpperCase()}`];
    if (envRpc && !isPlaceholder(envRpc)) {
      net.rpcUrls = envRpc.split(',').map((s) => s.trim()).filter(Boolean);
    }

    // Only override with a chain id that is actually a positive integer.
    // `Number('REPLACE_WITH_ROBINHOOD_CHAIN_ID')` is NaN, and NaN silently
    // overwrote the REQUIRED_FILL_ME sentinel — which made assertNetworkUsable()
    // pass on a network that has no real chain id. That is the exact failure
    // this whole placeholder mechanism exists to prevent, so it is rejected
    // here rather than being allowed to reach a signer.
    const envChainId = process.env[`SNIPER_CHAINID_${key.toUpperCase()}`];
    if (envChainId && !isPlaceholder(envChainId)) {
      const parsed = Number(envChainId);
      if (Number.isInteger(parsed) && parsed > 0) net.chainId = parsed;
    }
    if (net.explorerApi?.apiKeyEnv) net.explorerApi.apiKey = process.env[net.explorerApi.apiKeyEnv] || '';
  }
  for (const r of Object.values(cfg.resolvers || {})) {
    if (r.apiKeyEnv) r.apiKey = process.env[r.apiKeyEnv] || '';
  }
  return cfg;
}

// REQUIRED_FILL_ME is the sentinel in config/default.json. REPLACE_WITH_ is the
// one in .env.example — and `cp .env.example .env` is the documented first step,
// so an unedited template must be treated as unfilled too. Without this, the
// example RPC URL "https://REPLACE_WITH_ROBINHOOD_CHAIN_RPC_URL" reads as a
// configured endpoint and the guard passes on a network that cannot work.
const PLACEHOLDER = /REQUIRED_FILL_ME|REPLACE_WITH|REPLACE_ME/i;

/** True if this value is still an unfilled placeholder. */
function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0 || value.some((v) => isPlaceholder(v));
  // NaN reaches here when something non-numeric was coerced with Number().
  // It is never a valid chain id or URL, and `String(NaN)` matches no sentinel,
  // so it has to be rejected explicitly.
  if (typeof value === 'number') return !Number.isFinite(value);
  const s = String(value).trim();
  if (s === '' || s === 'NaN' || s === 'undefined' || s === 'null') return true;
  return PLACEHOLDER.test(s);
}

/**
 * Hard gate before any signing/broadcast on a network. Called by the scheduler
 * at arm time and by preWarm's caller — NOT lazily at T=0.
 */
function assertNetworkUsable(net) {
  const missing = [];
  if (isPlaceholder(net?.rpcUrls)) missing.push('rpcUrls');
  if (net?.kind === 'evm' && isPlaceholder(net?.chainId)) missing.push('chainId');
  if (missing.length) {
    throw new Error(
      `Network "${net?.name || '?'}" is not configured: ${missing.join(', ')} still ` +
        `set to REQUIRED_FILL_ME.\nFill config/default.json (or set SNIPER_RPC_${String(
          net?.name || ''
        ).toUpperCase()} / SNIPER_CHAINID_${String(net?.name || '').toUpperCase()}).\n` +
        `Refusing to run: a wrong chain id can send funds to a chain you don't control.`
    );
  }
  return true;
}

module.exports = { SCHEMA, assertNetworkUsable, close, get, init, isPlaceholder, loadConfig, migrate };

