'use strict';

/**
 * walletManager.js — per-user imported wallet handling.
 *
 * Users import an existing EVM private key. The same EVM address is then reused
 * across every configured EVM network (Ethereum / Base / Polygon / Robinhood),
 * which is how EVM addresses naturally work.
 */

const { Wallet: EvmWallet, formatEther, isAddress } = require('ethers');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const kms = require('./kms');
const { Users, Wallets } = require('../store/models');

function ensureWallets(telegramId) {
  const userId = String(telegramId);
  Users.upsert(userId);
  const evm = Wallets.find(userId, 'evm');
  const sol = Wallets.find(userId, 'solana');
  return {
   evm: evm ? { address: evm.address } : null,
   solana: sol ? { address: sol.address } : null,
  };
}

function normaliseEvmPrivateKey(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('empty private key');
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
  throw new Error('EVM private key must be 64 hex characters (optionally prefixed with 0x)');
}

function importEvmPrivateKey(telegramId, rawPrivateKey) {
  const userId = String(telegramId);
  Users.upsert(userId);
  const privateKey = normaliseEvmPrivateKey(rawPrivateKey);
  const wallet = new EvmWallet(privateKey);
  const { encrypted, iv } = kms.encryptSecret(privateKey, { userId, chain: 'evm' });
  Wallets.upsert({
   userId,
   chain: 'evm',
   address: wallet.address,
   encryptedPrivkey: encrypted,
   encryptionIv: iv,
  });
  return { address: wallet.address };
}

function normaliseSolanaSecret(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('empty Solana private key');
  let bytes;
  try {
    bytes = bs58.decode(trimmed);
  } catch {
    throw new Error('Solana private key must be base58-encoded');
  }
  if (bytes.length !== 64) {
    throw new Error('Solana private key must decode to 64 bytes');
  }
  return trimmed;
}

function importSolanaPrivateKey(telegramId, rawPrivateKey) {
  const userId = String(telegramId);
  Users.upsert(userId);
  const secret = normaliseSolanaSecret(rawPrivateKey);
  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  const { encrypted, iv } = kms.encryptSecret(secret, { userId, chain: 'solana' });
  Wallets.upsert({
    userId,
    chain: 'solana',
    address: keypair.publicKey.toBase58(),
    encryptedPrivkey: encrypted,
    encryptionIv: iv,
  });
  return { address: keypair.publicKey.toBase58() };
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
  if (!row) throw new Error('no EVM wallet for this user — import one with /importwallet first');
  return kms.withDecryptedSecret(
    { encrypted: row.encrypted_privkey, iv: row.encryption_iv, userId, chain: 'evm' },
    (privkey) => fn(privkey, row.address)
  );
}

async function withSolanaKey(telegramId, fn) {
  const userId = String(telegramId);
  const row = Wallets.find(userId, 'solana');
  if (!row) throw new Error('no Solana wallet for this user — import one with /importwallet solana first');
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
  importEvmPrivateKey,
  importSolanaPrivateKey,
  getAddresses,
  getEvmBalance,
  validateEvmAddress,
  verifyWallet,
  withEvmKey,
  withSolanaKey,
};
