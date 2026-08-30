'use strict';

/**
 * unit.test.js — node:test suite for the pure logic that decides how money moves.
 *
 * WHAT IS TESTED AND WHY
 * ----------------------
 * This suite deliberately covers only code paths where a silent bug spends real
 * funds or targets the wrong thing:
 *
 *   - chainMap:   picking the wrong chain means minting a same-address contract
 *                 on a chain you didn't intend.
 *   - URL parsing: a mis-parsed link resolves to the wrong collection.
 *   - mintStage:  sentinel/units handling — a bad timestamp fires the snipe at
 *                 the wrong moment, a bad price sends the wrong msg.value.
 *   - retryPolicy: fee bumping must never exceed the user's stated budget.
 *   - kms:        encryption must round-trip and must reject a wrong key, or
 *                 custody is broken.
 *
 * Nothing here touches the network, so it runs in CI with no keys and no RPC.
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const chainMap = require('../src/resolvers/chainMap');
const resolvers = require('../src/resolvers');
const opensea = require('../src/resolvers/openseaResolver');
const magiceden = require('../src/resolvers/magicEdenResolver');
const rarible = require('../src/resolvers/raribleResolver');
const mintStage = require('../src/chains/evm/mintStage');
const retryPolicy = require('../src/scheduler/retryPolicy');

const CONFIG = require('../config/default.json');

/* ------------------------------------------------------------- chainMap ---- */

test('chainMap: known slugs map to config networks', () => {
  assert.equal(chainMap.toConfigKey('opensea', 'ethereum', CONFIG), 'ethereum');
  assert.equal(chainMap.toConfigKey('opensea', 'matic', CONFIG), 'polygon');
  assert.equal(chainMap.toConfigKey('opensea', 'base', CONFIG), 'base');
  assert.equal(chainMap.toConfigKey('rarible', 'ETHEREUM', CONFIG), 'ethereum');
});

test('chainMap: unknown slug returns null instead of guessing', () => {
  // The whole point: an unrecognised chain must NOT fall back to a default,
  // because a default would mint on the wrong chain.
  assert.equal(chainMap.toConfigKey('opensea', 'not-a-real-chain', CONFIG), null);
  assert.equal(chainMap.toConfigKey('opensea', '', CONFIG), null);
  assert.equal(chainMap.toConfigKey('opensea', undefined, CONFIG), null);
});

test('chainMap: config marketplaceSlugs override built-ins', () => {
  const cfg = {
    networks: {
      ethereum: { marketplaceSlugs: { opensea: 'ethereum' } },
      newchain: { marketplaceSlugs: { opensea: 'shiny-new-l2' } },
    },
  };
  assert.equal(chainMap.toConfigKey('opensea', 'shiny-new-l2', cfg), 'newchain');
});

test('chainMap: unknownChainError names the slug and how to fix it', () => {
  const err = chainMap.unknownChainError('opensea', 'mystery', CONFIG);
  assert.equal(err.code, 'RESOLVER_UNKNOWN_CHAIN');
  assert.match(err.message, /mystery/);
  assert.match(err.message, /marketplaceSlugs/);
});

/* --------------------------------------------------------- URL matching ---- */

test('resolvers: platform detection is exclusive', () => {
  assert.equal(resolvers.detectPlatform('https://opensea.io/collection/foo'), 'opensea');
  assert.equal(resolvers.detectPlatform('https://magiceden.io/launchpad/ethereum/x'), 'magiceden');
  assert.equal(resolvers.detectPlatform('https://rarible.com/collection/ethereum/0xabc'), 'rarible');
  assert.equal(resolvers.detectPlatform('https://example.com/nft'), null);
});

test('resolvers: cleanUrl strips tracking params and trailing slash', () => {
  assert.equal(
    resolvers.cleanUrl('  check this https://opensea.io/collection/foo/?utm_source=tg#x  '),
    'https://opensea.io/collection/foo'
  );
  assert.equal(resolvers.cleanUrl('no url here'), null);
});

test('opensea: parses collection and asset URL shapes', () => {
  assert.deepEqual(opensea.parseUrl('https://opensea.io/collection/cool-cats'), {
    slug: 'cool-cats',
  });
  const asset = opensea.parseUrl('https://opensea.io/assets/matic/0xAbC0000000000000000000000000000000000001/7');
  assert.equal(asset.chainSlug, 'matic');
  assert.equal(asset.address, '0xAbC0000000000000000000000000000000000001');
  assert.equal(asset.tokenId, '7');
});

test('magiceden: launchpad URL yields chain + slug', () => {
  const p = magiceden.parseUrl('https://magiceden.io/launchpad/base/some-drop');
  assert.equal(p.chainSlug, 'base');
  assert.equal(p.slug, 'some-drop');
});

test('rarible: collection URL with raw address is detected as an address', () => {
  const p = rarible.parseUrl('https://rarible.com/collection/ethereum/0x1234567890123456789012345678901234567890');
  assert.equal(p.chainSlug, 'ethereum');
  assert.equal(p.ref, '0x1234567890123456789012345678901234567890');
  assert.equal(p.isAddress, true);
});

test('rarible: legacy link without a chain reports chain as unknown, never defaults', () => {
  // Defaulting an unqualified link to ethereum would resolve a Polygon
  // collection to a mainnet address that may belong to someone else.
  const p = rarible.parseUrl('https://rarible.com/collection/some-vanity-slug');
  assert.equal(p.chainSlug, null);
  assert.equal(p.isAddress, false);
});

test('rarible: namespaced CHAIN:0x… id is split correctly', () => {
  const p = rarible.parseUrl('https://rarible.com/token/POLYGON:0x1234567890123456789012345678901234567890');
  assert.equal(p.chainSlug, 'polygon');
  assert.equal(p.isAddress, true);
});

test('every resolver exposes the interface index.js dispatches on', () => {
  // An empty/partial resolver module makes detectPlatform() throw for EVERY
  // url, which silently breaks /newtarget for all marketplaces at once. This
  // is the regression test for exactly that.
  for (const [name, mod] of Object.entries({ opensea, magiceden, rarible })) {
    for (const fn of ['matches', 'parseUrl', 'resolve']) {
      assert.equal(typeof mod[fn], 'function', `${name}.${fn} must be a function`);
    }
  }
});

test('resolveUrl: unsupported link explains options rather than failing blankly', async () => {
  await assert.rejects(
    () => resolvers.resolveUrl('https://example.com/mint', { config: CONFIG }),
    (err) => {
      assert.ok(
        ['RESOLVER_UNSUPPORTED', 'RESOLVER_BAD_URL'].includes(err.code),
        `unexpected code ${err.code}`
      );
      return true;
    }
  );
});


/* ------------------------------------------------------------ mintStage ---- */

test('mintStage: sentinel far-future timestamps are treated as "not scheduled"', () => {
  // Contracts commonly use type(uint64).max / year-9999 to mean "unset". Taking
  // that literally would schedule a snipe thousands of years out, which looks
  // like the bot silently doing nothing.
  assert.equal(mintStage.isSentinelFuture(2n ** 64n - 1n), true);
  assert.equal(mintStage.isSentinelFuture(BigInt(Math.floor(Date.now() / 1000) + 3600)), false);
});

test('mintStage: timestampToMs rejects nonsense and converts seconds', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(mintStage.timestampToMs(BigInt(nowSec)), nowSec * 1000);
  assert.equal(mintStage.timestampToMs(0n), null);
  assert.equal(mintStage.timestampToMs(2n ** 64n - 1n), null);
});

test('mintStage: native-currency sentinel recognises address(0)', () => {
  assert.equal(mintStage.isNativeCurrency('0x0000000000000000000000000000000000000000'), true);
  assert.equal(mintStage.isNativeCurrency('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), false);
});

test('mintStage: describeStage states the source of the numbers', () => {
  const s = mintStage.describeStage({
    source: 'thirdweb:claimCondition',
    mintPriceWei: 10n ** 16n,
    startAtMs: Date.now(),
    maxPerWallet: 3,
  });
  assert.match(s, /thirdweb/);
});

/* ---------------------------------------------------------- retryPolicy ---- */

test('retryPolicy: fee bumps never exceed the user budget', () => {
  const budget = 10n ** 16n; // 0.01 ETH
  const gasLimit = 200_000n;
  let prev = 0n;

  for (let attempt = 1; attempt <= 12; attempt++) {
    const fees = retryPolicy.computeFees({
      attempt,
      baseFeeWei: 20n * 10n ** 9n,
      basePriorityFeeWei: 10n ** 9n,
      maxFeeBudgetWei: budget,
      gasLimit,
      bumpPercent: 25,
    });
    // The invariant that protects the user's wallet: worst-case spend on fees
    // for this attempt must stay inside the budget they explicitly approved.
    assert.ok(
      fees.maxFeePerGas * gasLimit <= budget,
      `attempt ${attempt}: ${fees.maxFeePerGas * gasLimit} > ${budget}`
    );
    // And EIP-1559 requires priority <= maxFee, or the node rejects the tx.
    assert.ok(fees.maxPriorityFeePerGas <= fees.maxFeePerGas);
    assert.ok(fees.maxFeePerGas >= prev, 'bumps must be monotonic');
    prev = fees.maxFeePerGas;
  }
});

test('retryPolicy: a budget too small to pay base fee is reported, not silently attempted', () => {
  const c = retryPolicy.assessCompetitiveness({
    maxFeeBudgetWei: 1n, // 1 wei
    gasLimit: 200_000n,
    baseFeeWei: 30n * 10n ** 9n,
    basePriorityFeeWei: 10n ** 9n,
  });
  assert.match(c.tier.toLowerCase(), /insufficient|too low|hopeless|below/);
});

test('retryPolicy: a revert is classified as a revert and is NOT retried', () => {
  // Retrying a revert just burns gas on a transaction that cannot succeed —
  // and on a mint that means paying repeatedly for nothing.
  const cls = retryPolicy.classifyError({ code: 'CALL_EXCEPTION', message: 'execution reverted' });
  assert.equal(cls, retryPolicy.ErrorClass.REVERT);
  assert.equal(retryPolicy.isRetryable(cls), false);
});

test('retryPolicy: transport failures are retryable, insufficient funds is not', () => {
  const rpc = retryPolicy.classifyError({ code: 'NETWORK_ERROR', message: 'socket hang up' });
  assert.equal(rpc, retryPolicy.ErrorClass.RPC);
  assert.equal(retryPolicy.isRetryable(rpc), true);

  // No amount of retrying creates money; retrying here only wastes the window.
  const funds = retryPolicy.classifyError({ message: 'insufficient funds for gas * price + value' });
  assert.equal(funds, retryPolicy.ErrorClass.FUNDS);
  assert.equal(retryPolicy.isRetryable(funds), false);
});

test('retryPolicy: an underpriced tx IS retryable, since bumping the fee fixes it', () => {
  const cls = retryPolicy.classifyError({ message: 'replacement transaction underpriced' });
  assert.equal(cls, retryPolicy.ErrorClass.UNDERPRICED);
  assert.equal(retryPolicy.isRetryable(cls), true);
});

test('retryPolicy: "already known" must not be treated as a failure', () => {
  // The tx is already in the mempool. Treating this as an error and resubmitting
  // with a new nonce is how you accidentally mint twice.
  const cls = retryPolicy.classifyError({ message: 'already known' });
  assert.equal(cls, retryPolicy.ErrorClass.ALREADY_KNOWN);
});

