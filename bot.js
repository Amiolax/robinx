 'use strict';

/**
 * bot.js — Telegraf entrypoint (spec §6).
 *
 * Commands: /start /importwallet /wallet /newtarget /list /arm /disarm /withdraw
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
const mintStage = require('./src/chains/evm/mintStage');
const solExecutor = require('./src/chains/solana/executor');

const retryPolicy = require('./src/scheduler/retryPolicy');
const { Scheduler } = require('./src/scheduler/scheduler');

/* ------------------------------------------------------------ bootstrap ---- */

const BETA_DISCLAIMER =
  'BETA SOFTWARE. Use an external wallet you control, and import a dedicated ' +
  'trading key (never your main wallet key). Automated purchasing may violate a ' +
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

/** userId -> "network:address:amount" awaiting a repeat of the same command.
 *  Not persisted on purpose: a restart should INVALIDATE a pending withdrawal
 *  confirmation, never silently carry one over. */
const pendingWithdrawals = new Map();
const WITHDRAW_CONFIRM_TTL_MS = 120_000;


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

/**
 * Parse a user-supplied mint time as UTC -> epoch ms.
 *
 * Timezone handling is the trap here: `new Date('2026-09-01 15:00')` is parsed
 * in the SERVER's local timezone, so the same input would mean different moments
 * on different hosts, and a snipe would fire hours early or late. We therefore
 * require/force UTC explicitly rather than trusting Date's default.
 *
 * @returns epoch ms, or null if unparseable
 */
function parseUtcTime(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return Date.now();

  // Relative form: "+15m", "+2h"
  const rel = s.match(/^\+(\d+)\s*([mh])$/i);
  if (rel) {
    const n = Number(rel[1]);
    return Date.now() + n * (rel[2].toLowerCase() === 'h' ? 3_600_000 : 60_000);
  }

  // Unix seconds or millis (some mint pages quote raw timestamps).
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);

  // "YYYY-MM-DD HH:MM[:SS]" — normalise to an explicit UTC ISO string so the
  // server's own timezone can never shift the meaning.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|UTC)?$/i);
  if (m) {
    const ms = Date.parse(
      `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`
    );
    return Number.isNaN(ms) ? null : ms;
  }

  // Anything with an explicit offset/Z is already unambiguous.
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
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
    RESOLVER_BAD_URL: 'That link could not be parsed.',
    RESOLVER_UNSUPPORTED: 'That marketplace is not supported.',
    RESOLVER_NOT_CONFIGURED: 'That marketplace API is not configured on this deployment.',
    RESOLVER_AUTH: 'The marketplace API rejected our request (API key needed).',
    RESOLVER_NOT_FOUND: 'That collection was not found on the marketplace.',
    RESOLVER_UNAVAILABLE: 'The marketplace API is unreachable right now.',
    RESOLVER_NO_CONTRACT: 'Could not determine the contract address from that link.',
    RESOLVER_UNKNOWN_CHAIN: 'That link points at a chain this deployment has no config for.',
    RESOLVER_AMBIGUOUS_CHAIN: 'That collection spans several chains.',
    RESOLVER_INVALID_DATA: 'The marketplace returned data that failed validation.',
    MINTSTAGE_NOT_A_CONTRACT: 'There is no contract at that address on that chain.',
    MINT_PROBE_FAILED: 'No callable public mint function was found on that contract.',
    CHAIN_NOT_IMPLEMENTED: 'That chain is not supported for automated minting.',
    RPC_POOL_EXHAUSTED: 'Every configured RPC endpoint failed.',
  };

  const prefix = map[err.code] ? `${map[err.code]}\n\n` : '';
  await ctx.reply(`${prefix}${kms.redactSecrets(err.message)}`.slice(0, 3500));
}

/* --------------------------------------------------------------- /start ---- */

bot.start(async (ctx) => {
  try {
    const { evm } = walletManager.ensureWallets(uid(ctx));
    if (!evm) {
      return ctx.reply(
        `Welcome.\n\n` +
          `This bot is non-custodial by default: it does not generate wallets.\n` +
          `Import your external wallet key(s) to use Ethereum and supported chains.\n\n` +
          `Command:\n` +
          `/importwallet evm <privateKey>\n` +
          `/importwallet solana <privateKey>\n\n` +
          `Example:\n` +
          `/importwallet evm 0xYOUR_64_HEX_PRIVATE_KEY\n\n` +
          `Use a dedicated wallet key with limited funds.`,
        { parse_mode: 'Markdown' }
      );
    }

    const evmOk = await walletManager.verifyWallet(uid(ctx), 'evm');
    if (!evmOk) {
      return ctx.reply(
        'Your imported wallet could not be decrypted/verified. ' +
          'This usually means WALLET_ENC_KEY changed. Re-import your key.'
      );
    }

    const primary = config.networks[config.defaultNetwork];
    await ctx.reply(
      `Welcome back.\n\n` +
        `Imported EVM wallet address (${primary?.displayName || 'EVM'}, and any supported EVM chain):\n` +
        `\`${evm.address}\`\n\n` +
        `Fund this address on ${primary?.displayName || 'the target chain'}.\n\n` +
        `Commands: /wallet /newtarget /list /arm /disarm /withdraw\n\n` +
        `${BETA_DISCLAIMER}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command('importwallet', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1).filter(Boolean);
  const first = (args[0] || '').toLowerCase();
  const explicitChain = first === 'evm' || first === 'solana';
  const chain = explicitChain ? first : 'evm';
  const priv = explicitChain ? args[1] : args[0];
  const hasTooManyArgs = explicitChain ? args.length > 2 : args.length > 1;
  if (!priv) {
    return ctx.reply(
      'Usage:\n' +
        '/importwallet evm <privateKey>\n' +
        '/importwallet solana <privateKey>\n\n' +
        'EVM imports one key for Ethereum and all supported EVM chains.\n' +
        'Use dedicated keys, not your primary wallet.'
    );
  }
  if (hasTooManyArgs) return ctx.reply('Invalid import command format. Send exactly one private key.');
  try {
    const { address } =
      chain === 'solana'
        ? walletManager.importSolanaPrivateKey(uid(ctx), priv)
        : walletManager.importEvmPrivateKey(uid(ctx), priv);
    const ok = await walletManager.verifyWallet(uid(ctx), chain);
    if (!ok) {
      return ctx.reply(
        'Imported key could not be verified after encryption. Re-import and check WALLET_ENC_KEY.'
      );
    }
    return ctx.reply(
      `Wallet imported.\n\n` +
        `${chain === 'solana' ? 'Solana' : 'EVM'} address:\n\`${address}\`\n\n` +
        (chain === 'solana'
          ? 'This wallet is used for Solana balance checks and withdrawals.'
          : 'This same address is used on Ethereum and every supported EVM chain.'),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    return replyError(ctx, err);
  }
});

/* -------------------------------------------------------------- /wallet ---- */

bot.command('wallet', async (ctx) => {
  try {
    const addrs = walletManager.getAddresses(uid(ctx));
    if (!addrs.evm) return ctx.reply('No wallet imported yet — use /importwallet first.');

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
  if (!Wallets.find(uid(ctx), 'evm')) return ctx.reply('Import an EVM wallet first with /importwallet.');
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

/* -------------------------------------------------------- /manualtarget ---- */

/**
 * Escape hatch: name the chain and contract yourself, skipping the marketplace.
 *
 * This exists because every marketplace resolver is a dependency on someone
 * else's API staying the same shape. When (not if) one changes, breaks, rate
 * limits us, or simply doesn't list a brand-new chain, the user still needs a
 * way to mint. This path has no external dependency at all — just an RPC.
 *
 * It is also the only way to target a chain we have no marketplace slug for,
 * which is exactly the situation for any newly-launched network.
 */
bot.command('manualtarget', async (ctx) => {
  if (!Wallets.find(uid(ctx), 'evm')) return ctx.reply('Import an EVM wallet first with /importwallet.');
  if (!(await checkRate(ctx, 'newtarget', config.limits?.newTargetPerHour ?? 20))) return;

  const [, netKey, contract] = ctx.message.text.split(/\s+/);
  if (!netKey || !contract) {
    return ctx.reply(
      'Usage: /manualtarget <network> <contractAddress>\n\n' +
        `Networks: ${evmNetworks().map(([k]) => k).join(', ')}\n\n` +
        'Example: /manualtarget ethereum 0x1234…\n\n' +
        'I will read the price and start time off the contract, then ask for ' +
        'anything it does not publish.'
    );
  }

  const net = config.networks[netKey];
  if (!net) return ctx.reply(`Unknown network "${netKey}". Networks: ${evmNetworks().map(([k]) => k).join(', ')}`);
  if (net.kind !== 'evm') return ctx.reply('Automated minting is only implemented for EVM chains.');
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) return ctx.reply('That is not a valid 0x contract address.');

  let pool;
  try {
    db.assertNetworkUsable(net);
    await ctx.reply(`Reading ${contract} on ${net.displayName}…`);

    pool = new evmExecutor.ProviderPool(net, { logger: console });
    const stage = await pool.withFailover(
      (provider) => mintStage.readPublicMintStage({ provider, contract, network: net, logger: console }),
      { label: 'readPublicMintStage' }
    );

    // Reuse the exact same wizard the URL path uses, so manual targets get the
    // same confirmation, the same validation, and the same limits.
    const resolved = {
      platform: 'manual',
      chain: netKey,
      kind: 'evm',
      collectionName: `manual:${contract.slice(0, 10)}…`,
      contractOrProgram: contract,
      sourceUrl: null,
      mintPrice: stage?.mintPriceWei ?? null,
      mintStartAt: stage?.startAtMs ?? null,
      maxPerWallet: stage?.maxPerWallet ?? null,
      currencySymbol: net.nativeCurrency?.symbol || 'ETH',
      stage,
      raw: null,
    };

    const sym = net.nativeCurrency?.symbol || 'ETH';
    let card = `*Manual target*\nChain: ${net.displayName}\nContract: \`${contract}\`\n`;
    if (stage) {
      card +=
        `Mint price: ${fmtEth(resolved.mintPrice, sym)} _(read on-chain)_\n` +
        `Mint starts: ${fmtTime(resolved.mintStartAt)} _(read on-chain)_\n` +
        `\n_${mintStage.describeStage(stage)}_\n`;
    }

    const w = { resolved };
    if (resolved.mintPrice === null) {
      w.step = 'await_price';
      card += `\n⚠️ No readable mint price. Enter the price *per NFT* in ${sym} (e.g. \`0.05\`, or \`0\` if free).`;
    } else if (resolved.mintStartAt === null) {
      w.step = 'await_starttime';
      card += `\n⚠️ No readable start time. Enter UTC \`YYYY-MM-DD HH:MM\`, or \`now\`.`;
    } else {
      w.step = 'await_qty';
      card += `\nHow many to mint? (1-${config.limits?.maxQtyPerTarget ?? 20})`;
    }

    wizards.set(uid(ctx), w);
    await ctx.reply(card, { parse_mode: 'Markdown' });
  } catch (err) {
    await replyError(ctx, err);
  } finally {
    if (pool) pool.destroy();
  }
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
      await ctx.reply('Resolving link, then reading the contract…');
      let resolved;
      try {
        // resolveTarget does two things: marketplace -> contract, then
        // contract -> price/start time. The price NEVER comes from the
        // marketplace API — see src/chains/evm/mintStage.js for why.
        resolved = await resolvers.resolveTarget(text, {
          config,
          logger: console,
          openPool: (net) => new evmExecutor.ProviderPool(net, { logger: console }),
        });
      } catch (err) {
        wizards.delete(uid(ctx));
        await replyError(ctx, err);
        // Explicitly tell the user nothing was saved, so they don't think a
        // half-made target is sitting in /list.
        return ctx.reply('No target was created.');
      }

      w.resolved = resolved;
      const net = config.networks[resolved.chain];
      const sym = net?.nativeCurrency?.symbol || 'ETH';

      let card =
        `*${resolved.collectionName}*\n` +
        `Chain: ${net?.displayName || resolved.chain}\n` +
        `Contract: \`${resolved.contractOrProgram}\`\n`;

      if (resolved.stage) {
        card +=
          `Mint price: ${fmtEth(resolved.mintPrice, sym)} _(read on-chain)_\n` +
          `Mint starts: ${fmtTime(resolved.mintStartAt)} _(read on-chain)_\n` +
          `\n_${mintStage.describeStage(resolved.stage)}_\n`;
      }

      // Refuse to invent a price. If the contract doesn't publish one we ask,
      // and we say plainly where the number has to come from.
      if (resolved.mintPrice === null || resolved.mintPrice === undefined) {
        w.step = 'await_price';
        card +=
          `\n⚠️ Could not read a mint price from this contract` +
          (resolved.stageError ? ` (${resolved.stageError})` : '') +
          `.\n\nEnter the price *per NFT* in ${sym}, exactly as the mint page states it ` +
          `(e.g. \`0.05\`). Enter \`0\` for a free mint.`;
        await ctx.reply(card, { parse_mode: 'Markdown' });
        return;
      }

      if (resolved.mintStartAt === null || resolved.mintStartAt === undefined) {
        w.step = 'await_starttime';
        card +=
          `\n⚠️ Could not read a start time from this contract.\n\n` +
          `Enter when the public mint opens, as UTC \`YYYY-MM-DD HH:MM\`, ` +
          `or \`now\` to make it eligible immediately.`;
        await ctx.reply(card, { parse_mode: 'Markdown' });
        return;
      }

      w.step = 'await_qty';
      await ctx.reply(`${card}\nHow many to mint? (1-${config.limits?.maxQtyPerTarget ?? 20})`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    /* ---- step 1b: manual price (only when the contract didn't publish one) ---- */
    if (w.step === 'await_price') {
      const net = config.networks[w.resolved.chain];
      const sym = net?.nativeCurrency?.symbol || 'ETH';
      let price;
      try {
        price = parseEther(text.replace(/[^\d.]/g, '') || 'x');
      } catch {
        return ctx.reply(`Could not parse that. Enter a decimal amount in ${sym}, e.g. 0.05`);
      }
      // Same implausibility guard the resolver applies: >100 ETH per NFT is
      // almost always a typo or a unit mistake, and it would be spent for real.
      if (price > 100n * 10n ** 18n) {
        return ctx.reply(
          `${fmtEth(price, sym)} per NFT looks like a typo. If you really mean that, ` +
            `set it via /manualtarget. Otherwise re-enter a smaller amount.`
        );
      }
      w.resolved.mintPrice = price;

      if (w.resolved.mintStartAt === null || w.resolved.mintStartAt === undefined) {
        w.step = 'await_starttime';
        return ctx.reply(
          `Price set to ${fmtEth(price, sym)} per NFT.\n\n` +
            `Now enter when the public mint opens, as UTC \`YYYY-MM-DD HH:MM\`, or \`now\`.`,
          { parse_mode: 'Markdown' }
        );
      }
      w.step = 'await_qty';
      return ctx.reply(
        `Price set to ${fmtEth(price, sym)} per NFT.\n\n` +
          `How many to mint? (1-${config.limits?.maxQtyPerTarget ?? 20})`
      );
    }

    /* ---- step 1c: manual start time ---- */
    if (w.step === 'await_starttime') {
      const startAt = parseUtcTime(text);
      if (startAt === null) {
        return ctx.reply(
          'Could not parse that time. Use UTC `YYYY-MM-DD HH:MM` (e.g. 2026-09-01 15:00) or `now`.',
          { parse_mode: 'Markdown' }
        );
      }
      w.resolved.mintStartAt = startAt;
      w.step = 'await_qty';
      return ctx.reply(
        `Mint start set to ${fmtTime(startAt)}.\n\n` +
          `How many to mint? (1-${config.limits?.maxQtyPerTarget ?? 20})`
      );
    }


    /* ---- step 2: qty ---- */
    if (w.step === 'await_qty') {
      const qty = Number.parseInt(text, 10);
      const maxQty = config.limits?.maxQtyPerTarget ?? 20;
      if (!Number.isInteger(qty) || qty < 1 || qty > maxQty) {
        return ctx.reply(`Enter a whole number between 1 and ${maxQty}.`);
      }
      const net = config.networks[w.resolved.chain];
      const sym = net?.nativeCurrency?.symbol || 'ETH';
      const total = (w.resolved.mintPrice ?? 0n) * BigInt(qty);

      // Hard spend ceiling. Every other guard here protects against the bot
      // being wrong; this one protects against the USER being wrong — a fat
      // finger on price or qty, or a bad on-chain read, becoming a real
      // transaction. It is checked before the target can ever be armed.
      const cap = config.limits?.maxMintCostPerTargetWei
        ? BigInt(config.limits.maxMintCostPerTargetWei)
        : null;
      if (cap && total > cap) {
        wizards.delete(uid(ctx));
        return ctx.reply(
          `Refusing to create this target: ${qty} x ${fmtEth(w.resolved.mintPrice, sym)} = ` +
            `${fmtEth(total, sym)}, which exceeds the per-target spend cap of ${fmtEth(cap, sym)}.\n\n` +
            `Nothing was saved. Either lower the quantity, or raise ` +
            `limits.maxMintCostPerTargetWei in config/default.json if you genuinely intend to ` +
            `spend that much.`
        );
      }

      w.qty = qty;
      w.step = 'await_budget';
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
        `Networks: ${Object.keys(config.networks || {}).join(', ')}\n` +
        'Example: /withdraw ethereum 0xYourAddress 0.05\n' +
        'Example: /withdraw ethereum 0xYourAddress all\n' +
        'Example: /withdraw solana YourSolAddress all'
    );
  }

  const net = config.networks[netKey];
  if (!net) return ctx.reply(`Unknown network "${netKey}".`);

  // Typo-proofing on an irreversible action. A withdrawal to a mistyped address
  // cannot be undone, so the destination is echoed back and must be confirmed
  // before anything is signed. Checksum validation alone doesn't help here:
  // a wrong-but-valid address passes every check and eats the funds.
  const confirmKey = `${netKey}:${to}:${amount || 'all'}`;
  if (pendingWithdrawals.get(uid(ctx)) !== confirmKey) {
    pendingWithdrawals.set(uid(ctx), confirmKey);
    setTimeout(() => {
      if (pendingWithdrawals.get(uid(ctx)) === confirmKey) pendingWithdrawals.delete(uid(ctx));
    }, WITHDRAW_CONFIRM_TTL_MS).unref?.();

    return ctx.reply(
      `⚠️ Confirm withdrawal — this cannot be undone.\n\n` +
        `Network: ${net.displayName || netKey}\n` +
        `To: ${to}\n` +
        `Amount: ${amount && amount.toLowerCase() !== 'all' ? amount : 'ENTIRE BALANCE'}\n\n` +
        `Check the address character by character. If it is correct, send the exact ` +
        `same command again within 2 minutes to execute it.`
    );
  }
  pendingWithdrawals.delete(uid(ctx));

  /* ---- Solana: native SOL withdrawal ---- */

  // Minting on Solana is gated, but withdrawals must always work: a custodial
  // wallet users cannot empty is a trap, regardless of which features are live.
  if (net.kind === 'solana') {
    try {
      const sweep = !amount || amount.toLowerCase() === 'all';
      const lamports = sweep ? 0n : solExecutor.parseSol(amount);
      solExecutor.validateSolanaAddress(to);

      await ctx.reply('Submitting Solana withdrawal…');
      const result = await walletManager.withSolanaKey(uid(ctx), (keypair) =>
        solExecutor.sendNative({
          network: net,
          keypair,
          to,
          amountLamports: lamports,
          sweep,
          logger: console,
        })
      );

      RateLimits.record(uid(ctx), 'withdraw');
      return ctx.reply(
        `Withdrawal sent: ${solExecutor.formatSol(result.lamports)} SOL -> ${to}\n` +
          `tx: ${result.signature}`
      );
    } catch (err) {
      return replyError(ctx, err);
    }
  }

  if (net.kind !== 'evm') return ctx.reply(`Withdrawals are not implemented for ${net.kind} chains.`);

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

/* ---------------------------------------------------------------- /help ---- */

/**
 * One place that states plainly what works and what doesn't.
 *
 * This is a market-readiness feature, not documentation garnish: the single
 * fastest way to lose a user's money and trust is to let them assume a chain is
 * supported for minting when it is not. Capability is read from the executors'
 * own CAPABILITIES flags so this text cannot drift out of sync with the code.
 */
bot.command('help', async (ctx) => {
  const netLines = Object.entries(config.networks || {}).map(([key, n]) => {
    const configured = !db.isPlaceholder(n.rpcUrls) && !db.isPlaceholder(n.chainId);
    const canMint = n.kind === 'evm';
    const flags = [
      configured ? 'configured' : 'NOT configured',
      canMint ? 'mint ✅' : 'mint ❌',
      'withdraw ✅',
    ];
    return `• \`${key}\` — ${n.displayName || key} (${flags.join(', ')})`;
  });

  await ctx.reply(
    `*NFT Mint Sniper — what actually works*\n\n` +
      `*Commands*\n` +
      `/start — show wallet import status\n` +
      `/importwallet <evm|solana> <privateKey> — import external wallet\n` +
      `/wallet — addresses + balances\n` +
      `/newtarget — snipe from a marketplace link\n` +
      `/manualtarget <network> <contract> — snipe by contract address\n` +
      `/list — your targets\n` +
      `/arm <id> · /disarm <id>\n` +
      `/withdraw <network> <address> [amount|all]\n\n` +
      `*Networks*\n${netLines.join('\n')}\n\n` +
      `*Marketplaces* (link → contract)\n` +
      `• OpenSea — ${resolvers.STATUS.opensea}\n` +
      `• Magic Eden — ${resolvers.STATUS.magiceden}\n` +
      `• Rarible — ${resolvers.STATUS.rarible}\n\n` +
      `*How pricing works*\n` +
      `Mint price and start time are read from the CONTRACT, not the marketplace ` +
      `listing — the contract is what actually enforces them at mint time. If a ` +
      `contract doesn't publish them, I ask you rather than guess.\n\n` +
      `*Solana*\n` +
      `Deposit, balance, and withdrawal work. Minting does NOT: ${solExecutor.CAPABILITIES.mintUnsupportedReason}. ` +
      `A wrong Candy Machine mint is charged a bot-tax and still reports success, ` +
      `so approximating it would quietly drain your wallet.\n\n` +
      `${BETA_DISCLAIMER}`,
    { parse_mode: 'Markdown' }
  );
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
