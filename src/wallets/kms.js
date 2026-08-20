'use strict';

/**
 * kms.js — key encryption at rest (spec §7).
 *
 * AES-256-GCM. Master key from env WALLET_ENC_KEY (never from a file in-repo,
 * never hardcoded). Swap this module for a real KMS/HSM before you hold anything
 * you'd miss; the interface (encrypt/decrypt over a utf8 secret) is deliberately
 * small so a cloud-KMS implementation can drop in behind it.
 *
 * SCHEMA NOTE
 * -----------
 * The spec's Wallet model has `encrypted_privkey` + `encryption_iv` only, but
 * GCM also yields a 16-byte auth tag which is REQUIRED to detect tampering.
 * Rather than add an off-spec column, the stored payload is:
 *
 *     encrypted_privkey = "v1:" + base64(authTag) + ":" + base64(ciphertext)
 *     encryption_iv     = base64(iv)
 *
 * Versioned prefix so a future key-rotation/algorithm change is detectable.
 *
 * SECURITY RULES ENFORCED HERE
 *  - Decrypted material is returned as a Buffer/string to the caller and never
 *    logged, never stringified into an error message.
 *  - Errors are deliberately vague to the caller ("decryption failed") so a
 *    tampering probe learns nothing from the message.
 *  - Additional Authenticated Data binds each ciphertext to its owning user +
 *    chain, so a row can't be copied between users to steal a key.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce: the GCM-recommended size
const VERSION = 'v1';

let cachedKey = null;

/**
 * Load and validate the master key from env.
 * Accepts 64 hex chars or 44-char base64 (both decode to 32 bytes).
 * Throws loudly at startup rather than at first signing attempt.
 */
function getMasterKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.WALLET_ENC_KEY;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'WALLET_ENC_KEY is not set. Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        'and put it in .env. Without it, wallet keys cannot be encrypted or read.'
    );
  }
  if (/^(CHANGE_?ME|REQUIRED_FILL_ME|placeholder)/i.test(raw.trim())) {
    throw new Error('WALLET_ENC_KEY is still the .env.example placeholder. Set a real random key.');
  }

  let key;
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else {
    try {
      key = Buffer.from(s, 'base64');
    } catch {
      key = Buffer.alloc(0);
    }
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `WALLET_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Use 64 hex chars or 32 bytes of base64.'
    );
  }
  cachedKey = key;
  return key;
}

/** True if a usable master key is configured — for a startup self-check. */
function isConfigured() {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind ciphertext to its logical owner so rows aren't interchangeable.
 * Any change to userId/chain makes decryption fail closed.
 */
function buildAad({ userId, chain }) {
  if (userId === undefined || userId === null || !chain) {
    throw new Error('kms: userId and chain are required (used as AAD)');
  }
  return Buffer.from(`${VERSION}|${userId}|${chain}`, 'utf8');
}

/**
 * @param {string} plaintext  secret material (hex privkey / base58 secret key)
 * @param {{userId: string|number, chain: string}} context
 * @returns {{encrypted: string, iv: string}} both base64-wrapped, safe to persist
 */
function encryptSecret(plaintext, context) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('kms: refusing to encrypt empty secret');
  }
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const aad = buildAad(context);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: `${VERSION}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`,
    iv: iv.toString('base64'),
  };
}

/**
 * @returns {string} plaintext secret. CALLER MUST NOT LOG THIS.
 * @throws generic error on any tampering/wrong-key/wrong-owner condition.
 */
function decryptSecret({ encrypted, iv, userId, chain }) {
  const key = getMasterKey();
  try {
    const parts = String(encrypted).split(':');
    if (parts.length !== 3 || parts[0] !== VERSION) {
      throw new Error('unrecognised payload format');
    }
    const authTag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    const ivBuf = Buffer.from(String(iv), 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
    decipher.setAAD(buildAad({ userId, chain }));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Intentionally opaque: no plaintext, no key material, no distinguishing
    // between "wrong key", "tampered ciphertext" and "wrong owner".
    const e = new Error(
      'wallet key decryption failed — wrong WALLET_ENC_KEY, corrupted row, or mismatched owner'
    );
    e.code = 'DECRYPT_FAILED';
    throw e;
  }
}

/**
 * Run `fn(secret)` and best-effort scrub the reference afterwards.
 *
 * HONEST CAVEAT: JS strings are immutable and GC-managed, so this cannot
 * guarantee the secret is gone from memory — it only narrows the window and
 * keeps the plaintext out of long-lived scope. Real scrubbing needs a native
 * KMS/enclave signer. Documented rather than pretended-away.
 */
async function withDecryptedSecret(record, fn) {
  let secret = decryptSecret(record);
  try {
    return await fn(secret);
  } finally {
    secret = null;
  }
}

/** Redact anything key-shaped before it can reach a log line. */
function redactSecrets(str) {
  return String(str)
    .replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted-privkey>')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '<redacted-hex>')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/g, '<redacted-base58-key>');
}

module.exports = {
  ALGORITHM,
  VERSION,
  decryptSecret,
  encryptSecret,
  getMasterKey,
  isConfigured,
  redactSecrets,
  withDecryptedSecret,
};
