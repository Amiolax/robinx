'use strict';

/**
 * walletManager.js — per-user custodial keypairs (spec §7).
 *
 * One EVM keypair and one Solana keypair per Telegram user. The EVM keypair is
 * reused across every EVM network (same address on Robinhood Chain / Ethereum /
 * Base / Polygon) — that's how EVM addresses work, and it means a user has one
 * deposit address to remember per ecosystem.
 *
 * SEPARATE HOT WALLET PER USER, not a shared pool — spec §7 requires this. It
 * caps blast radius: compromising one user's ciphertext yields one user's funds.
 *
 * Private keys are:
 *   - generated with crypto-grade randomness (ethers / @solana/web3.js)
 *   - immediately encrypted via kms.js
 *   - only ever decrypted inside getSigner*(), at signing time
 *   - never returned to a Telegram handler, never logged
 */

const { Wallet: EvmWallet, formatEther, isAddress } = require('ethers');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const kms = require('./kms');
const { Users, Wallets } = require('../store/models');

/**
 * Create (or fetch) both wallets for a user. Idempotent — /start can be run
 * repeatedly without regenerating keys, which would orphan deposited funds.
 *
 * @returns {{evm: {address}, solana: {address}, created: boolean}}
 */
function ensureWallets(telegramId) {
  const userId = String(telegramId);
  Users.upsert(userId);

  let created = false;

  let evm = Wallets.find(userId, 'evm');
  if (!evm) {
    const w = EvmWallet.createRandom();
    const { encrypted, iv } = kms.encryptSecret(w.privateKey, { userId, chain: 'evm' });
    evm = Wallets.create({
      userId,
      chain: 'evm',
      address: w.address,
      encryptedPrivkey: encrypted,
      encryptionIv: iv,
    });
    created = true;
  }

  let sol = Wallets.find(userId, 'solana');
  if (!sol) {
    const kp = Keypair.generate();
    // base58 of the 64-byte secret key — the standard Solana wallet format.
    const secret = bs58.encode(Buffer.from(kp.secretKey));
    const { encrypted, iv } = kms.encryptSecret(secret, { userId, chain: 'solana' });
    sol = Wallets.create({
      userId,
      chain: 'solana',
      address: kp.publicKey.toBase58(),
      encryptedPrivkey: encrypted,
      encryptionIv: iv,
    });
    created = true;
  }

  return { evm: { address: evm.address }, solana: { address: sol.address }, created };
}

/** Public addresses only — safe to send to a chat. */
function getAddresses(telegramId) {
  const rows = Wallets.listForUser(telegramId);
  const out = {};
  for (const r of rows) out[r.chain] = r.address;
  return out;
}

/**
 * Decrypt the EVM private key and hand it to `fn`. The key never leaves this
 * closure. Do not return it from `fn`.
 */
async function withEvmKey(telegramId, fn) {
  const userId = String(telegramId);
  const row = Wallets.find(userId, 'evm');
  if (!row) throw new Error('no EVM wallet for this user — run /start first');
  return kms.withDecryptedSecret(
    { encrypted: row.encrypted_privkey, iv: row.encryption_iv, userId, chain: 'evm' },
    (privkey) => fn(privkey, row.address)
  );
}

async function withSolanaKey(telegramId, fn) {
  const userId = String(telegramId);
  const row = Wallets.find(userId, 'solana');
  if (!row) throw new Error('no Solana wallet for this user — run /start first');
  return kms.withDecryptedSecret(
    { encrypted: row.encrypted_privkey, iv: row.encryption_iv, userId, chain: 'solana' },
    (secret) => fn(Keypair.fromSecretKey(bs58.decode(secret)), row.address)
  );
}

/**
 * Verify a stored key still decrypts AND still derives its recorded address.
 * Catches a wrong WALLET_ENC_KEY or a corrupted row at /start rather than at
 * T=0 with the user's money on the line.
 */
async function verifyWallet(telegramId, chain) {
  try {
    if (chain === 'evm') {
      return await withEvmKey(telegramId, (pk, addr) => new EvmWallet(pk).address === addr);
    }
    return await withSolanaKey(telegramId, (kp, addr) => kp.publicKey.toBase58() === addr);
  } catch {
    return false;
  }
}

/** Native balance for one EVM network, via an already-warm ProviderPool. */
async function getEvmBalance(pool, address) {
  const wei = await pool.withFailover((p) => p.getBalance(address), { label: 'getBalance' });
  return { wei, formatted: formatEther(wei) };
}

/** Reject bad withdrawal destinations before we build a tx. */
function validateEvmAddress(addr) {
  if (!isAddress(addr)) throw new Error(`not a valid EVM address: ${String(addr).slice(0, 64)}`);
  if (/^0x0{40}$/i.test(addr)) throw new Error('refusing to withdraw to the zero address');
  return addr;
}

module.exports = {
  ensureWallets,
  getAddresses,
  getEvmBalance,
  validateEvmAddress,
  verifyWallet,
  withEvmKey,
  withSolanaKey,
};
