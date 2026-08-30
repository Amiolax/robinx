'use strict';

/**
 * executor.js (Solana) — balance reads, native SOL transfer, and an explicitly
 * gated mint path.
 *
 * WHAT IS AND ISN'T IMPLEMENTED, AND WHY
 * --------------------------------------
 * Implemented, because these are unambiguous and safe:
 *   - getBalance()   : lamports -> SOL, with RPC failover.
 *   - sendNative()   : withdraw SOL out of a custodial wallet (users must always
 *                      be able to get their money out; a custodial wallet you
 *                      can't withdraw from is a trap).
 *
 * NOT implemented, deliberately:
 *   - Candy Machine v3 minting. This is not laziness — it is the single most
 *     expensive thing in this codebase to get wrong. A CMv3 mint is a
 *     `mintV2` instruction whose account list must be assembled in an exact
 *     order, and whose contents depend on which "guards" the creator enabled
 *     (solPayment, tokenPayment, allowList, mintLimit, nftGate, startDate,
 *     redeemedAmount, …). Each enabled guard injects its own extra accounts,
 *     often in a guard-specific position.
 *
 *     The reason a wrong account list is worse here than on EVM: the default
 *     CMv3 config includes a `botTax` guard, which is designed to CHARGE a
 *     failed minter (commonly ~0.01 SOL) and SUCCEED the transaction anyway.
 *     So a malformed mint does not revert harmlessly the way a bad EVM calldata
 *     does — it silently takes the user's SOL, reports success, and delivers no
 *     NFT. Retrying makes it worse, and our retry loop is built to retry.
 *
 *     Doing this correctly requires @metaplex-foundation/mpl-candy-machine to
 *     fetch the live candy guard account and derive the account list from the
 *     actual enabled guards. That dependency is intentionally not installed yet
 *     (see package.json "comments"). Until it is, attemptMint() throws before
 *     touching a keypair.
 *
 * The gate is enforced in code, not just documented, so no future caller can
 * accidentally route a Solana target into the fire path.
 */

const { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');

const LAMPORTS_PER_SOL_BIG = BigInt(LAMPORTS_PER_SOL);

/** Rent-exempt minimum for a basic account. Leaving less than this on a wallet
 *  can make it purgeable, so a full sweep always keeps the account payable. */
const RENT_EXEMPT_RESERVE_LAMPORTS = 890_880n;

/** Fee for a 1-signature transfer. Padded for priority-fee headroom. */
const TRANSFER_FEE_RESERVE_LAMPORTS = 15_000n;

/* --------------------------------------------------------- connections ---- */

function rpcUrls(network) {
  const urls = Array.isArray(network?.rpcUrls) ? network.rpcUrls.filter(Boolean) : [];
  if (!urls.length) {
    throw new Error(`Solana network config has no rpcUrls (network: ${network?.name || 'solana'})`);
  }
  return urls;
}

/**
 * Try `fn` against each endpoint until one works.
 *
 * Solana's public RPC is aggressively rate-limited, so treating a failure as
 * "try the next endpoint" rather than "give up" is the difference between a
 * working /wallet command and an intermittently broken one.
 */
async function withFailover(network, fn, { label = 'rpc', commitment = 'confirmed', logger = console } = {}) {
  const urls = rpcUrls(network);
  let lastErr;
  for (const url of urls) {
    try {
      const conn = new Connection(url, {
        commitment,
        confirmTransactionInitialTimeout: network.rpcTimeoutMs ?? 30_000,
      });
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      logger.warn?.(`[solana] ${label} failed on ${redact(url)}: ${err.message}`);
    }
  }
  const e = new Error(`all Solana RPC endpoints failed for ${label}: ${lastErr?.message}`);
  e.code = 'RPC_POOL_EXHAUSTED';
  e.cause = lastErr;
  throw e;
}

/** RPC URLs frequently embed an API key; never log the path. */
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<rpc>';
  }
}

/* -------------------------------------------------------------- reads ---- */

/** Format lamports as SOL without floating point. */
function formatSol(lamports) {
  const n = BigInt(lamports);
  const whole = n / LAMPORTS_PER_SOL_BIG;
  const frac = n % LAMPORTS_PER_SOL_BIG;
  if (frac === 0n) return whole.toString();
  // 9 decimal places, trailing zeros trimmed.
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/** Parse a decimal SOL string to lamports with string math (no float). */
function parseSol(input) {
  const s = String(input).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new Error(`not a valid SOL amount: ${String(input).slice(0, 32)}`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > 9) throw new Error('SOL has at most 9 decimal places');
  return BigInt(whole || '0') * LAMPORTS_PER_SOL_BIG + BigInt((frac || '0').padEnd(9, '0'));
}

function validateSolanaAddress(addr) {
  try {
    const pk = new PublicKey(String(addr));
    // A valid-looking key that isn't on the ed25519 curve can't hold funds in
    // the normal sense; refuse rather than send into a black hole.
    if (!PublicKey.isOnCurve(pk.toBytes())) {
      throw new Error('address is not a valid ed25519 public key (it may be a PDA)');
    }
    return pk.toBase58();
  } catch (err) {
    throw new Error(`not a valid Solana address: ${String(addr).slice(0, 64)} (${err.message})`);
  }
}

/**
 * Native SOL balance.
 * @returns {{lamports: BigInt, sol: string, formatted: string}}
 */
async function getBalance(network, address) {
  const pk = new PublicKey(address);
  const lamports = await withFailover(network, (conn) => conn.getBalance(pk), { label: 'getBalance' });
  const big = BigInt(lamports);
  return { lamports: big, sol: formatSol(big), formatted: formatSol(big) };
}

/* ------------------------------------------------------------- writes ---- */

/**
 * Send native SOL. Used by /withdraw.
 *
 * @param keypair  a @solana/web3.js Keypair (supplied inside walletManager's
 *                 withSolanaKey closure — never persisted or logged here)
 * @param sweep    when true, send the whole balance minus fee + rent reserve
 */
async function sendNative({ network, keypair, to, amountLamports, sweep = false, logger = console }) {
  const destination = new PublicKey(validateSolanaAddress(to));
  const from = keypair.publicKey;

  const balance = BigInt(
    await withFailover(network, (conn) => conn.getBalance(from), { label: 'getBalance(withdraw)' })
  );

  const reserve = TRANSFER_FEE_RESERVE_LAMPORTS + RENT_EXEMPT_RESERVE_LAMPORTS;
  const value = sweep ? balance - reserve : BigInt(amountLamports);

  if (value <= 0n) {
    throw new Error(
      `nothing to withdraw: balance ${formatSol(balance)} SOL does not cover the ` +
        `${formatSol(reserve)} SOL fee + rent reserve`
    );
  }
  if (value + reserve > balance) {
    throw new Error(
      `insufficient balance: requested ${formatSol(value)} SOL + ${formatSol(reserve)} SOL ` +
        `fee/rent reserve exceeds balance ${formatSol(balance)} SOL`
    );
  }

  const signature = await withFailover(
    network,
    async (conn) => {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
      const tx = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(
        SystemProgram.transfer({ fromPubkey: from, toPubkey: destination, lamports: value })
      );
      tx.sign(keypair);
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      return sig;
    },
    { label: 'sendNative' }
  );

  logger.info?.(`[solana] withdrawal ${signature} (${formatSol(value)} SOL -> ${destination.toBase58()})`);
  return { txHash: signature, signature, value, lamports: value };
}

/* --------------------------------------------------------- mint (gated) ---- */

/**
 * Candy Machine mint — HARD GATED, see the file header.
 *
 * Throws with code CHAIN_NOT_IMPLEMENTED so bot.js renders the standard
 * "that chain is not wired up yet" explanation instead of a stack trace.
 */
async function attemptMint() {
  const e = new Error(
    'Solana Candy Machine minting is not implemented.\n\n' +
      'This is a refusal, not a bug. A Candy Machine v3 mint needs its account list built from ' +
      'the drop\'s live guard configuration, and the default botTax guard CHARGES you (~0.01 SOL) ' +
      'while REPORTING SUCCESS when that list is wrong. An approximate implementation would quietly ' +
      'drain a wallet across retries and deliver no NFT.\n\n' +
      'EVM chains (Ethereum, Base, Polygon, and any configured L2) are fully supported for minting. ' +
      'Solana wallets here can still receive, hold, and withdraw SOL.'
  );
  e.code = 'CHAIN_NOT_IMPLEMENTED';
  throw e;
}

/** Advertise capability explicitly so callers branch on data, not on comments. */
const CAPABILITIES = Object.freeze({
  balance: true,
  withdraw: true,
  mint: false,
  mintUnsupportedReason: 'Candy Machine guard-aware account assembly not implemented (botTax risk)',
});

module.exports = {
  CAPABILITIES,
  LAMPORTS_PER_SOL_BIG,
  RENT_EXEMPT_RESERVE_LAMPORTS,
  TRANSFER_FEE_RESERVE_LAMPORTS,
  attemptMint,
  formatSol,
  getBalance,
  parseSol,
  redact,
  sendNative,
  validateSolanaAddress,
  withFailover,
};
