'use strict';

/**
 * bot.js — Telegraf entrypoint (spec §6).
 *
 * Commands: /start /wallet /newtarget /list /arm /disarm /withdraw
 *
 * Two rules this file follows throughout:
 *
 *  1. NEVER echo secret material. Handlers only ever see addresses; private keys
 *     live behind walletManager.withEvmKey/withSolanaKey.
 *  2. Be honest about what is not wired. Where a path is a stub, the bot says so
 *     plainly instead of failing in a way that looks like a bug. Spec §5 and §7
 *     both call for this ("be honest with the user", "clear disclaimer").
 */

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { formatEther, parseEther } = require('ethers');

const db = require('./src/store/db');
const { Executions, RateLimits, Targets, TargetStatus, Wallets } = require('./src/store/models');
const walletManager = require('./src/wallets/walletManager');
const kms = require('./src/wallets/kms');
const resolvers = require('./src/resolvers');
const evmExecutor = require('./src/chains/evm/executor');
const solExecutor = require('./src/chains/solana/executor');
const retryPolicy = require('./src/scheduler/retryPolicy');
const { Scheduler } = require('./src/scheduler/scheduler');

/* ------------------------------------------------------------ bootstrap ---- */

const BETA_DISCLAIMER =
  'BETA / CUSTODIAL SOFTWARE. This bot holds your private keys on its server. ' +
  'Only deposit what you can afford to lose. Automated purchasing may violate a ' +
  'marketplace\'s terms of service — that risk is yours.';

function requireEnv() {
  const missing = [];
  if (!process.env.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!kms.isConfigured()) missing.push('WALLET_ENC_KEY (32 bytes hex/base64)');
  if (missing.length) {
    console.error(`\nCannot start — missing/invalid env:\n  - ${missing.join('\n  - ')}\n`);
    console.error('Copy .env.example to .env and fill it in. See README.\n');
    process.exit(1);
  }
}

requireEnv();

const config = db.loadConfig();
db.init(config.store?.path || './data/sniper.db');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const scheduler = new Scheduler({
  config,
  logger: console,
  notify: async (userId, message) => {
    await bot.telegram.sendMessage(userId, message, { disable_web_page_preview: true });
  },
});

/** In-memory /newtarget wizard state. Deliberately not persisted: a half-filled
 *  wizard is worthless after a restart, and it keeps URLs out of the DB early. */
const wizards = new Map();

/* -------------------------------------------------------------- helpers ---- */

const uid = (ctx) => String(ctx.from.id);

function evmNetworks() {
  return Object.entries(config.networks || {}).filter(([, n]) => n.kind === 'evm');
}

/** Format a wei BigInt for display without floating point. */
function fmtEth(wei, symbol = 'ETH') {
  if (wei === null || wei === undefined) return 'unknown';
  return `${formatEther(wei)} ${symbol}`;
}

function fmtTime(ms) {
  if (!ms) return 'unknown';
  const d = new Date(ms);
  const delta = ms - Date.now();
  const rel =
    delta < 0
      ? `${Math.round(-delta / 60000)}m ago`
      : delta < 3_600_000
        ? `in ${Math.round(delta / 60000)}m`
        : `in ${(delta / 3_600_000).toFixed(1)}h`;
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC (${rel})`;
}

/** spec §7: rate limit, persisted so a restart can't reset the window. */
async function checkRate(ctx, action, limit) {
  const r = RateLimits.check(uid(ctx), action, limit);
  if (!r.allowed) {
    await ctx.reply(
      `Rate limit: ${r.limit} ${action} per hour. Try again in ` +
        `${Math.ceil(r.retryAfterMs / 60000)} minute(s).`
    );
    return false;
  }
  return true;
}

/** Uniform error rendering — resolver codes get a human explanation. */
async function replyError(ctx, err) {
  const map = {
    RESOLVER_NOT_IMPLEMENTED: 'That marketplace is not wired up yet.',
    RESOLVER_MAPPING_UNIMPLEMENTED: 'The OpenSea response mapping is not finished yet.',
    RESOLVER_NOT_CONFIGURED: 'The OpenSea API endpoint is not configured yet.',
    RESOLVER_AUTH: 'The marketplace API rejected our request (API key needed).',
    RESOLVER_NOT_FOUND: 'That collection was not found on the marketplace.',
    RESOLVER_UNAVAILABLE: 'The marketplace API is unreachable right now.',
    CHAIN_NOT_IMPLEMENTED: 'That chain is not wired up yet.',
  };
  const prefix = map[err.code] ? `${map[err.code]}\n\n` : '';
  await ctx.reply(`${prefix}${kms.redactSecrets(err.message)}`.slice(0, 3500));
}

/* --------------------------------------------------------------- /start ---- */

bot.start(async (ctx) => {
  try {
    const { evm, solana, created } = walletManager.ensureWallets(uid(ctx));

    // Verify the stored keys actually round-trip before telling anyone to fund
    // them. Catches a wrong WALLET_ENC_KEY now, not at withdrawal time.
    const evmOk = await walletManager.verifyWallet(uid(ctx), 'evm');
    const solOk = await walletManager.verifyWallet(uid(ctx), 'solana');
    if (!evmOk || !solOk) {
      return ctx.reply(
        'Your wallet records exist but could not be decrypted/verified. ' +
          'This usually means WALLET_ENC_KEY changed. Do NOT deposit. Contact the operator.'
      );
    }

    const primary = config.networks[config.defaultNetwork];
    await ctx.reply(
      `${created ? 'Wallets created.' : 'Welcome back.'}\n\n` +
        `EVM deposit address (${primary?.displayName || 'EVM'}, and any EVM chain):\n` +
        `\`${evm.address}\`\n\n` +
        `Solana deposit address:\n\`${solana.address}\`\n\n` +
        `Fund the EVM address to snipe on ${primary?.displayName || 'the primary chain'}.\n\n` +
        `Commands: /wallet /newtarget /list /arm /disarm /withdraw\n\n` +
        `${BETA_DISCLAIMER}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await replyError(ctx, err);
  }
});

/* -------------------------------------------------------------- /wallet ---- */

bot.command('wallet', async (ctx) => {
  try {
    const addrs = walletManager.getAddresses(uid(ctx));
    if (!addrs.evm) return ctx.reply('No wallet yet — run /start first.');

    const lines = [`EVM address: \`${addrs.evm}\``];

    for (const [key, net] of evmNetworks()) {
      if (db.isPlaceholder(net.rpcUrls) || (net.kind === 'evm' && db.isPlaceholder(net.chainId))) {
        lines.push(`• ${net.displayName}: not configured (RPC/chainId missing)`);
        continue;
      }
      let pool;
      try {
        pool = new evmExecutor.ProviderPool(net, { logger: console });
        const bal = await walletManager.getEvmBalance(pool, addrs.evm);
        lines.push(`• ${net.displayName}: ${bal.formatted} ${net.nativeCurrency?.symbol || 'ETH'}`);
      } catch (err) {
        lines.push(`• ${net.displayName}: RPC error (${err.code || 'unreachable'})`);
      } finally {
        if (pool) pool.destroy();
      }
    }

    if (addrs.solana) {
      lines.push('', `Solana address: \`${addrs.solana}\``);
      try {
        const sol = await solExecutor.getBalance(config.networks.solana, addrs.solana);
        lines.push(`• Solana: ${sol.formatted} SOL  _(minting on Solana is not implemented)_`);
      } catch {
        lines.push('• Solana: RPC error');
      }
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    await replyError(ctx, err);
  }
});

/* ----------------------------------------------------------- /newtarget ---- */

bot.command('newtarget', async (ctx) => {
  if (!Wallets.find(uid(ctx), 'evm')) return ctx.reply('Run /start first to create a wallet.');
  if (!(await checkRate(ctx, 'newtarget', config.limits?.newTargetPerHour ?? 20))) return;

  const armed = Targets.countArmedForUser(uid(ctx));
  if (armed >= (config.limits?.maxArmedTargetsPerUser ?? 10)) {
    return ctx.reply(`You already have ${armed} armed targets (limit reached). /disarm one first.`);
  }

  wizards.set(uid(ctx), { step: 'await_url' });
  await ctx.reply(
    'Paste the mint link (OpenSea, Magic Eden, or Rarible).\n\n' +
      `Resolver status:\n` +
      `• OpenSea — ${resolvers.STATUS.opensea}\n` +
      `• Magic Eden — ${resolvers.STATUS.magiceden}\n` +
      `• Rarible — ${resolvers.STATUS.rarible}\n\n` +
      'Send /cancel to abort.'
  );
});

bot.command('cancel', async (ctx) => {
  wizards.delete(uid(ctx));
  await ctx.reply('Cancelled.');
});

/**
 * Wizard driver. Steps: await_url -> await_qty -> await_budget -> confirm.
 * Free text is only consumed when a wizard is active, so it never swallows
 * unrelated messages.
 */
bot.on('text', async (ctx, next) => {
  const w = wizards.get(uid(ctx));
  if (!w) return next();
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  try {
    /* ---- step 1: URL -> resolve ---- */
    if (w.step === 'await_url') {
      await ctx.reply('Resolving…');
      let resolved;
      try {
        resolved = await resolvers.resolveUrl(text, { config, logger: console });
      } catch (err) {
        wizards.delete(uid(ctx));
        await replyError(ctx, err);
        // Explicitly tell the user nothing was saved, so they don't think a
        // half-made target is sitting in /list.
        return ctx.reply('No target was created.');
      }

      w.resolved = resolved;
      w.step = 'await_qty';
      const net = config.networks[resolved.chain];
      await ctx.reply(
        `*${resolved.collectionName}*\n` +
          `Chain: ${net?.displayName || resolved.chain}\n` +
          `Contract: \`${resolved.contractOrProgram}\`\n` +
          `Mint price: ${fmtEth(resolved.mintPrice, net?.nativeCurrency?.symbol)}\n` +
          `Mint starts: ${fmtTime(resolved.mintStartAt)}\n\n` +
          `How many to mint? (1-${config.limits?.maxQtyPerTarget ?? 20})`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    /* ---- step 2: qty ---- */
    if (w.step === 'await_qty') {
      const qty = Number.parseInt(text, 10);
      const maxQty = config.limits?.maxQtyPerTarget ?? 20;
      if (!Number.isInteger(qty) || qty < 1 || qty > maxQty) {
        return ctx.reply(`Enter a whole number between 1 and ${maxQty}.`);
      }
      w.qty = qty;
      w.step = 'await_budget';
      const net = config.networks[w.resolved.chain];
      const sym = net?.nativeCurrency?.symbol || 'ETH';
      const total = (w.resolved.mintPrice ?? 0n) * BigInt(qty);
      return ctx.reply(
        `Quantity: ${qty}\nMint cost: ${fmtEth(total, sym)}\n\n` +
          `Now set your max GAS/FEE budget in ${sym} (this is on top of the mint cost, ` +
          `and is the ceiling for fee bumping during retries).\n\nExample: 0.01`
      );
    }

    /* ---- step 3: budget -> confirm card ---- */
    if (w.step === 'await_budget') {
      let budget;
      try {
        budget = parseEther(text.replace(/[^\d.]/g, ''));
      } catch {
        return ctx.reply('Could not parse that amount. Enter a decimal like 0.01');
      }
      if (budget <= 0n) return ctx.reply('Budget must be greater than zero.');

      w.maxFeeBudget = budget;
      const r = w.resolved;
      const net = config.networks[r.chain];
      const sym = net?.nativeCurrency?.symbol || 'ETH';

      const target = Targets.create({
        userId: uid(ctx),
        sourceUrl: r.sourceUrl,
        platform: r.platform,
        chain: r.chain,
        contractOrProgram: r.contractOrProgram,
        collectionName: r.collectionName,
        mintPrice: r.mintPrice,
        mintStartAt: r.mintStartAt,
        qty: w.qty,
        maxFeeBudget: budget,
        resolverMeta: r.raw ? { platform: r.platform, keys: Object.keys(r.raw) } : null,
      });

      RateLimits.record(uid(ctx), 'newtarget');
      wizards.delete(uid(ctx));

      // Honest competitiveness read-out (spec §5) — no guarantees implied.
      let competitiveness = '';
      try {
        const c = retryPolicy.assessCompetitiveness({
          maxFeeBudgetWei: budget,
          gasLimit: 200_000n, // rough pre-probe placeholder; refined at pre-warm
          baseFeeWei: 0n,
          basePriorityFeeWei: BigInt(net?.policy?.defaultPriorityFeeWei ?? 100_000_000),
        });
        competitiveness = `\nFee competitiveness: ${c.tier} — ${c.note}`;
      } catch {
        /* non-fatal */
      }

      return ctx.reply(
        `*Target #${target.id} created*\n\n` +
          `${r.collectionName}\n` +
          `Chain: ${net?.displayName || r.chain}\n` +
          `Contract: \`${r.contractOrProgram}\`\n` +
          `Qty: ${w.qty}\n` +
          `Mint cost: ${fmtEth((r.mintPrice ?? 0n) * BigInt(w.qty), sym)}\n` +
          `Fee budget: ${fmtEth(budget, sym)}\n` +
          `Mint starts: ${fmtTime(r.mintStartAt)}` +
          `${competitiveness}\n\n` +
          `Arm it with: /arm ${target.id}\n\n` +
          `_Success is never guaranteed — you are competing with other bots._`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    wizards.delete(uid(ctx));
    await replyError(ctx, err);
  }
});

/* ---------------------------------------------------------------- /list ---- */

bot.command('list', async (ctx) => {
  const rows = Targets.listForUser(uid(ctx));
  if (!rows.length) return ctx.reply('No targets yet. Create one with /newtarget.');

  const lines = rows.slice(0, 25).map((t) => {
    const net = config.networks[t.chain];
    const sym = net?.nativeCurrency?.symbol || 'ETH';
    const last = Executions.lastForTarget(t.id);
    return (
      `#${t.id} [${t.status.toUpperCase()}] ${t.collection_name || t.platform}\n` +
      `   ${net?.displayName || t.chain} · qty ${t.qty} · ` +
      `price ${fmtEth(t.mint_price, sym)} · budget ${fmtEth(t.max_fee_budget, sym)}\n` +
      `   starts ${fmtTime(t.mint_start_at)}` +
      (last?.error_message ? `\n   last: ${String(last.error_message).slice(0, 90)}` : '')
    );
  });

  await ctx.reply(
    `${lines.join('\n\n')}\n\n/arm <id> · /disarm <id>` +
      (rows.length > 25 ? `\n\n(showing 25 of ${rows.length})` : '')
  );
});

/* ----------------------------------------------------------------- /arm ---- */

bot.command('arm', async (ctx) => {
  const id = Number.parseInt((ctx.message.text.split(/\s+/)[1] || '').trim(), 10);
  if (!Number.isInteger(id)) return ctx.reply('Usage: /arm <id>   (see /list)');

  // Scoped lookup: a user can never arm someone else's target.
  const t = Targets.findForUser(id, uid(ctx));
  if (!t) return ctx.reply(`Target #${id} not found.`);
  if ([TargetStatus.ARMED, TargetStatus.FIRING].includes(t.status)) {
    return ctx.reply(`Target #${id} is already ${t.status}.`);
  }
  if ([TargetStatus.DONE].includes(t.status)) return ctx.reply(`Target #${id} already completed.`);

  try {
    // Warn on an obviously unfunded wallet before arming, while the user can act.
    const net = config.networks[t.chain];
    db.assertNetworkUsable(net);
    const need = (t.mint_price ?? 0n) * BigInt(t.qty) + (t.max_fee_budget ?? 0n);
    let pool;
    try {
      pool = new evmExecutor.ProviderPool(net, { logger: console });
      const addrs = walletManager.getAddresses(uid(ctx));
      const bal = await walletManager.getEvmBalance(pool, addrs.evm);
      if (bal.wei < need) {
        await ctx.reply(
          `Warning: balance ${bal.formatted} ${net.nativeCurrency?.symbol || 'ETH'} is below the ` +
            `${formatEther(need)} needed (mint cost + fee budget). Arming anyway, but it will likely fail.`
        );
      }
    } catch {
      /* balance check is advisory only */
    } finally {
      if (pool) pool.destroy();
    }

    const r = await scheduler.arm(id);
    await ctx.reply(
      `Target #${id} ARMED.\n` +
        `Pre-warm in ${Math.max(0, Math.round(r.preWarmsInMs / 1000))}s, ` +
        `fires in ${Math.round(r.firesInMs / 1000)}s.\n\n` +
        `I'll message you at pre-warm and with the result. /disarm ${id} to cancel.`
    );
  } catch (err) {
    await replyError(ctx, err);
  }
});

/* -------------------------------------------------------------- /disarm ---- */

bot.command('disarm', async (ctx) => {
  const id = Number.parseInt((ctx.message.text.split(/\s+/)[1] || '').trim(), 10);
  if (!Number.isInteger(id)) return ctx.reply('Usage: /disarm <id>');

  const t = Targets.findForUser(id, uid(ctx));
  if (!t) return ctx.reply(`Target #${id} not found.`);

  const wasFiring = scheduler.isFiring(id);
  const r = scheduler.disarm(id);
  await ctx.reply(
    wasFiring || r.wasFiring
      ? `Target #${id} was already firing — stopped further retries, but a transaction may ` +
          `already be in the mempool and could still confirm.`
      : `Target #${id} disarmed.`
  );
});

/* ------------------------------------------------------------ /withdraw ---- */

bot.command('withdraw', async (ctx) => {
  if (!(await checkRate(ctx, 'withdraw', config.limits?.withdrawPerHour ?? 5))) return;

  const parts = ctx.message.text.split(/\s+/).slice(1);
  const [netKey, to, amount] = parts;

  if (!netKey || !to) {
    return ctx.reply(
      'Usage: /withdraw <network> <address> [amount|all]\n\n' +
        `Networks: ${evmNetworks().map(([k]) => k).join(', ')}\n` +
        'Example: /withdraw robinhood 0xYourAddress 0.05\n' +
        'Example: /withdraw robinhood 0xYourAddress all\n\n' +
        'Solana withdrawals are not implemented yet.'
    );
  }

  const net = config.networks[netKey];
  if (!net) return ctx.reply(`Unknown network "${netKey}".`);
  if (net.kind !== 'evm') return ctx.reply('Only EVM withdrawals are implemented.');

  let pool;
  try {
    db.assertNetworkUsable(net);
    walletManager.validateEvmAddress(to);

    const sweep = !amount || amount.toLowerCase() === 'all';
    const amountWei = sweep ? 0n : parseEther(amount);

    pool = new evmExecutor.ProviderPool(net, { logger: console });
    await ctx.reply('Submitting withdrawal…');

    const result = await walletManager.withEvmKey(uid(ctx), (privkey) =>
      evmExecutor.sendNative({
        pool,
        signerKey: privkey,
        to,
        amountWei,
        network: net,
        sweep,
        logger: console,
      })
    );

    RateLimits.record(uid(ctx), 'withdraw');
    const link =
      net.blockExplorerTxUrl && !db.isPlaceholder(net.blockExplorerTxUrl)
        ? `\n${net.blockExplorerTxUrl}${result.txHash}`
        : `\ntx: ${result.txHash}`;
    await ctx.reply(
      `Withdrawal sent: ${formatEther(result.value)} ${net.nativeCurrency?.symbol || 'ETH'} -> ${to}${link}`
    );
  } catch (err) {
    await replyError(ctx, err);
  } finally {
    if (pool) pool.destroy();
  }
});

/* --------------------------------------------------------------- errors ---- */

bot.catch((err, ctx) => {
  // Never leak key material into logs, even via an unexpected stack.
  console.error(`[bot] unhandled error in ${ctx?.updateType}:`, kms.redactSecrets(err.stack || err.message));
});

/* --------------------------------------------------------------- launch ---- */

async function main() {
  const primary = config.networks[config.defaultNetwork];
  console.log(`[bot] primary network: ${primary?.displayName} (${config.defaultNetwork})`);
  try {
    db.assertNetworkUsable(primary);
  } catch (err) {
    // Start anyway so /start and /wallet work, but make the gap unmissable.
    console.warn(`\n[bot] WARNING — primary network not usable yet:\n${err.message}\n`);
  }

  await scheduler.resumeAll();
  await bot.launch();
  console.log('[bot] running');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.log(`\n[bot] ${sig} — shutting down`);
    scheduler.shutdown();
    bot.stop(sig);
    db.close();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[bot] fatal:', err);
    process.exit(1);
  });
}

module.exports = { bot, config, scheduler };
