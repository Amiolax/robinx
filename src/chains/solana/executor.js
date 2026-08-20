'use strict';

/**
 * executor.js (Solana) — STUB, with the read-only parts implemented.
 *
 * The MINT/SEND path is not implemented: it depends on candyMachine.js, which is
 * a stub (see the botTax reasoning in that file). Attempting a mint throws.
 *
 * What IS implemented here: balance lookup, so /wallet can honestly report a
 * user's SOL balance for the wallet the bot generated for them. Generating a
 * deposit address a user can fund while being unable to show them the balance
 * would be worse than useless.
 *
 * When the mint path is built, it must mirror the EVM executor's structure:
 *   preWarm()       -> open connection, cache a recent blockhash, keep it fresh
 *   buildTemplate() -> pre-build the unsigned tx; simulate it (loud failure)
 *   fire()          -> setComputeUnitPrice up to the user's budget, re-broadcast
 *                      with skipPreflight after the first simulated attempt, bump
 *                      the priority fee per retry, stop on budget/timeout
 * plus the Jito bundle tier mentioned in spec §5, which needs a block-engine
 * endpoint and tip account that I don't have confirmed values for.
 */

const { Connection, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');

const NOT_IMPLEMENTED =
  'Solana mint execution is not implemented (stub). ' +
  'Robinhood Chain / EVM is the wired path — see README "What is wired vs stubbed".';

/** Implemented: open a connection (also used by /wallet). */
function connect(network) {
  const url = network?.rpcUrls?.[0];
  if (!url) throw new Error('solana network config missing rpcUrls');
  return new Connection(url, 'confirmed');
}

/** Implemented: native SOL balance. */
async function getBalance(network, address) {
  const conn = connect(network);
  const lamports = await conn.getBalance(new PublicKey(address));
  return { lamports: BigInt(lamports), formatted: (lamports / LAMPORTS_PER_SOL).toFixed(9) };
}

async function preWarm() {
  const e = new Error(NOT_IMPLEMENTED);
  e.code = 'CHAIN_NOT_IMPLEMENTED';
  throw e;
}

async function buildTemplate() {
  const e = new Error(NOT_IMPLEMENTED);
  e.code = 'CHAIN_NOT_IMPLEMENTED';
  throw e;
}

async function fire() {
  const e = new Error(NOT_IMPLEMENTED);
  e.code = 'CHAIN_NOT_IMPLEMENTED';
  throw e;
}

module.exports = { NOT_IMPLEMENTED, buildTemplate, connect, fire, getBalance, preWarm };
