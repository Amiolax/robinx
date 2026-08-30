# Deploying tg-sniper

Read [README.md](./README.md) first, especially **Security**. Users import
external wallet keys; treat this deployment as sensitive key-handling software.

---

## Blockers — the bot cannot snipe until these are done

The bot **boots** without these, so `/start` and `/wallet` work, but `/arm` will
refuse and `/newtarget` will fail at the resolve step. Deploying first is fine;
just know that's the state.

| # | Blocker | Where | Why it isn't guessed |
|---|---|---|---|
| 1 | Robinhood Chain **RPC URL** + **chain ID** | `.env` (`SNIPER_RPC_ROBINHOOD`, `SNIPER_CHAINID_ROBINHOOD`) or `config/default.json` | A wrong chain ID signs a transaction for the wrong chain. `assertNetworkUsable()` refuses to run on `REQUIRED_FILL_ME`. |
| 2 | OpenSea `apiBaseUrl` + `chainSlug` | `config/default.json` → `resolvers.opensea` | The exact endpoint/slug for Robinhood Chain drops is unconfirmed. |
| 3 | `openseaResolver.mapResponse()` | `src/resolvers/openseaResolver.js` | Needs one real API response. See README "Finishing the OpenSea resolver". |

Verify the chain ID against **two** independent sources (the RPC's own
`eth_chainId` and official docs). Check the RPC responds before trusting it:

```bash
curl -s -X POST "$SNIPER_RPC_ROBINHOOD" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x..."}   convert hex -> decimal, must equal SNIPER_CHAINID_ROBINHOOD
```

---

## 1. Secrets

`.env` is already created locally and gitignored (mode 600) with a freshly
generated `WALLET_ENC_KEY`. Fill in the rest:

```bash
nano .env      # TELEGRAM_BOT_TOKEN, SNIPER_RPC_ROBINHOOD, SNIPER_CHAINID_ROBINHOOD, OPENSEA_API_KEY
```

### Back up WALLET_ENC_KEY before a single user funds a wallet

```bash
grep '^WALLET_ENC_KEY=' .env      # copy to a password manager, off this machine
```

Lose it and **every user wallet becomes permanently undecryptable** — the funds
are gone. It is not recoverable from the database. Back up the key **and**
`data/sniper.db` together; either alone is useless.

Never commit `.env`. Never paste the key into a chat, an issue, or a CI log.

---

## 2. Where to host it

This is a **long-running worker with no HTTP server** — Telegram long-polling is
outbound-only. That rules out most "web service" tiers, and anything that sleeps
on idle: a sleeping bot misses the mint.

Requirements:

- Always-on, no idle sleep, no cold starts.
- **Persistent disk** for `data/sniper.db` (encrypted user keys). Ephemeral
  filesystems lose every wallet on redeploy.
- **Exactly one instance.** SQLite + in-memory schedule state means two
  replicas both resume the same armed targets and double-fire. Never scale this
  to 2.
- Low latency to the chain RPC — you're racing other bots. Prefer a region near
  your RPC provider.

| Option | Verdict |
|---|---|
| VPS (Hetzner / DigitalOcean / Fly machine w/ volume) | **Recommended.** Full control, real disk, pick your region. |
| Railway / Render **worker** (not web service) + persistent volume | Works. Set replicas = 1. |
| Heroku free-style / anything that sleeps | **No.** Ephemeral disk *and* sleeps. |
| Vercel / Netlify / Lambda | **No.** Serverless can't hold a polling loop or a DB file. |

---

## 3. Deploy

### Option A — Docker Compose (recommended)

```bash
docker compose up -d --build
docker compose logs -f            # expect: [bot] running
```

The DB lives in the named volume `sniper-data`, so `down`/`up` and rebuilds keep
user wallets. Back it up:

```bash
docker run --rm -v sniper-data:/d -v "$PWD":/b alpine \
  tar czf /b/sniper-db-backup.tar.gz -C /d .
```

### Option B — systemd on a VPS

See the install steps in the header of [`deploy/tg-sniper.service`](./deploy/tg-sniper.service).

```bash
sudo systemctl status tg-sniper
journalctl -u tg-sniper -f
```

### Option C — plain node (dev only)

```bash
npm ci && npm start
```

No restart-on-crash. Don't use this for anything holding funds.

---

## 4. Post-deploy checks

```bash
docker compose logs --tail=50     # or: journalctl -u tg-sniper -n 50
```

- `[bot] primary network: Robinhood Chain (robinhood)` — config loaded.
- `[bot] running` — connected to Telegram.
- A `WARNING — primary network not usable yet` block means blocker #1 is still open.

Then in Telegram: `/start` → import instructions. Run `/importwallet evm <key>`,
then `/wallet` and
confirm it reports a balance rather than `not configured` / `RPC error`.

Restart it once and confirm armed targets survive (`scheduler.resumeAll()`), and
that `/start` for an existing user does **not** say "wallet could not be
decrypted" — that means `WALLET_ENC_KEY` changed between runs.

---

## 5. Before you let anyone else use it

The README lists these as not implemented, and they matter once real money is
involved:

- No 2FA on withdrawals, no withdrawal-address allowlist.
- Master key is an env var, not a hardware KMS — root on the host can decrypt
  every user wallet.
- No audit logging.
- Public mempool only; no private relay.

Also: automated purchasing may breach marketplace ToS, and holding user funds
may carry licensing obligations in your jurisdiction. Both are your risk.

The safest first deployment is **you as the only user**, with a small balance.

---

## 6. Updating

```bash
git pull
docker compose up -d --build      # or: npm ci && sudo systemctl restart tg-sniper
```

`WALLET_ENC_KEY` must stay identical across updates, and `data/` must survive.
Disarm targets before a deliberate restart when you can — a restart mid-fire
can't recall a transaction already in the mempool.
