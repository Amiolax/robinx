'use strict';

/**
 * walletManager.js — imported wallet keys (spec §7).
 *
 * Non-custodial onboarding: users bring their own wallets via private key import.
 * The imported EVM key is reused across every EVM network.
 *
 * Imported keys are:
 *   - validated before storage
 *   - encrypted immediately via kms.js
 *   - only ever decrypted inside getSigner*(), at signing time
 *   - never returned to a Telegram handler, never logged
 */

const { Wallet: EvmWallet, formatEther, isAddress } = require('ethers');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const kms = require('./kms');
const { Users, Wallets } = require('../store/models');

/**
 * Import or replace a user's EVM wallet from an external private key.
 */
function importEvmWallet(telegramId, privateKey) {
  const userId = String(telegramId);
  Users.upsert(userId);
  const key = String(privateKey || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('invalid EVM private key: expected 0x + 64 hex chars');
  }
  const w = new EvmWallet(key);
  const { encrypted, iv } = kms.encryptSecret(w.privateKey, { userId, chain: 'evm' });
  const row = Wallets.upsert({
    userId,
    chain: 'evm',
    address: w.address,
    encryptedPrivkey: encrypted,
    encryptionIv: iv,
  });
  return { address: row.address };
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
  if (!row) throw new Error('no EVM wallet for this user — import one with /importwallet');
  return kms.withDecryptedSecret(
    { encrypted: row.encrypted_privkey, iv: row.encryption_iv, userId, chain: 'evm' },
    (privkey) => fn(privkey, row.address)
  );
}

async function withSolanaKey(telegramId, fn) {
  const userId = String(telegramId);
  const row = Wallets.find(userId, 'solana');
  if (!row) throw new Error('no Solana wallet for this user');
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
    return false;
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
  importEvmWallet,
  getAddresses,
  getEvmBalance,
  validateEvmAddress,
  verifyWallet,
  withEvmKey,
  withSolanaKey,
};
