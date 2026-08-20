'use strict';

/**
 * candyMachine.js — STUB. Candy Machine v2/v3 mint instruction builder.
 *
 * NOT IMPLEMENTED. Robinhood Chain (EVM) is the primary target per the build
 * order; Solana/Magic Eden is secondary. The Magic Eden resolver that would feed
 * this is also a stub, so nothing can reach this code path today.
 *
 * WHY THIS IS A STUB RATHER THAN A BEST-EFFORT ATTEMPT
 * ---------------------------------------------------
 * CM v2 and v3 have materially different mint instructions:
 *   - v2: mintNft on the candy machine program, with a separate whitelist token
 *         path and its own collection-authority handling.
 *   - v3 (mpl-candy-machine-core + candy guard): mintV2 through the CANDY GUARD
 *         program, where guards (solPayment, allowList, startDate, mintLimit,
 *         botTax…) each contribute their own remaining_accounts in a specific
 *         order.
 *
 * The guard account ordering in v3 is the crux: get it wrong and the tx doesn't
 * politely fail, it can trip botTax, which BURNS SOL on every failed attempt.
 * Combined with a retry loop that's designed to re-broadcast aggressively, a
 * wrong guard layout would drain a user's balance in seconds. That's not a thing
 * to approximate.
 *
 * WHAT AN IMPLEMENTATION NEEDS
 *   - @metaplex-foundation/mpl-candy-machine (umi-based) as the builder
 *   - detect v2 vs v3 from the account owner program id
 *   - fetch the candy guard config and construct remaining_accounts in the exact
 *     order the guard set requires
 *   - pre-create the mint keypair + ATA during pre-warm, not at T=0
 *   - a simulateTransaction() dry run before broadcast, mirroring the loud-failure
 *     behaviour of the EVM probe in src/chains/evm/erc721Mint.js
 */

const NOT_IMPLEMENTED =
  'Solana Candy Machine mint is not implemented (stub). ' +
  'Robinhood Chain / EVM is the wired path — see README "What is wired vs stubbed".';

/** Detect CM version from an on-chain account. TODO. */
async function detectVersion() {
  const e = new Error(NOT_IMPLEMENTED);
  e.code = 'CHAIN_NOT_IMPLEMENTED';
  throw e;
}

/** Build the mint instruction(s). TODO — must not guess guard account order. */
async function buildMintInstructions() {
  const e = new Error(NOT_IMPLEMENTED);
  e.code = 'CHAIN_NOT_IMPLEMENTED';
  throw e;
}

module.exports = { NOT_IMPLEMENTED, buildMintInstructions, detectVersion };
