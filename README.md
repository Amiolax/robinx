# tg-sniper

NFT mint-sniper Telegram bot. **Primary target: Robinhood Chain** (Ethereum L2, Arbitrum Orbit rollup) with OpenSea as the resolver.

Built from `nft-sniper-bot-spec.md`. Node.js + Telegraf + better-sqlite3 + ethers v6.

---


**This is beta BYOW software.** Users import existing external EVM wallets via private key (`/importwallet`) instead of receiving bot-generated wallets.

**Two things are deliberately unfinished** and the bot will tell you so rather than guessing:

1. **`config/default.json` has no Robinhood Chain RPC URL or chain ID.** They're `"REQUIRED_FILL_ME"`. A guessed chain ID signs transactions for the wrong chain; a guessed RPC URL points at nothing. The bot refuses to arm a target on a network with placeholder values.
2. **`openseaResolver.mapResponse()` is unimplemented.** Everything around it is wired — URL parsing, HTTP transport with retry/auth handling, and post-mapping validation. What's missing is the field mapping, which requires seeing one real OpenSea API response for a Robinhood Chain drop. See [Finishing the OpenSea resolver](#finishing-the-opensea-resolver).

---

## What is wired vs. stubbed

| Component | Status |
|---|---|
| **EVM executor** (`src/chains/evm/executor.js`) | **Fully implemented.** Multi-RPC failover, pre-warm/keep-alive, pre-build + simulate, T=0 fire-and-retry with per-attempt gas bumping, budget ceiling enforcement, native withdrawal. |
| **EVM mint builder** (`src/chains/evm/erc721Mint.js`) | **Fully implemented.** Verified-ABI lookup with fallback to a generic `mint()`/`claim()` selector set; probes candidates via `eth_call` and fails loudly. |
| **Scheduler** (`src/scheduler/`) | **Fully implemented.** T-30s pre-warm, T=0 fire, drift-corrected sleep, restart resume, backoff/bump policy. |
| **Wallets** (`src/wallets/`) | **EVM import implemented.** Users import an external EVM private key; key is encrypted at rest (AES-256-GCM). |
| **Store** (`src/store/`) | **Fully implemented.** SQLite, spec §3 schema. |
| **Bot commands** (`bot.js`) | **Fully implemented.** All seven commands + `/newtarget` wizard. |
| **OpenSea resolver** | **Partially wired.** URL patterns, transport, validation done. `mapResponse()` throws pending a real API sample. |
| **Magic Eden resolver** | **Stub.** Response shape + endpoint documented; `resolve()` throws `RESOLVER_NOT_IMPLEMENTED`. |
| **Rarible resolver** | **Stub.** Same treatment. |
| **Solana Candy Machine** | **Stub.** `getBalance()` works so `/wallet` is honest; minting throws. See the file for why the v3 candy-guard account ordering isn't worth approximating (botTax burns SOL on failure). |

Stubs **throw with a clear reason**. Nothing returns fake mint data — a fabricated price or start time spends real money at the wrong number or the wrong moment.

---

## Setup

```bash
npm install
cp .env.example .env
npm run genkey          # -> paste into WALLET_ENC_KEY
```

Then fill in `.env`:

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `WALLET_ENC_KEY` — from `npm run genkey`. **Back this up.** Lose it and every user wallet is permanently undecryptable.
- `SNIPER_RPC_ROBINHOOD` + `SNIPER_CHAINID_ROBINHOOD` — see below
- `OPENSEA_API_KEY` — required for most OpenSea v2 endpoints

Run:

```bash
npm run check    # syntax check every file
npm start
```

`npm start` warns loudly but still boots if the primary network is unconfigured, so `/start`, `/importwallet`, and `/wallet` work while you're setting up.

---

## Configuring Robinhood Chain

`config/default.json` → `networks.robinhood`:

```json
{
  "chainId": "REQUIRED_FILL_ME",
  "rpcUrls": ["REQUIRED_FILL_ME"]
}
```

Fill both (or set the env vars). Get chain IDs and RPC URLs from chainlist.org (and verify against official chain docs). The executor cross-checks the configured ID against what the RPC reports and **refuses to run on a mismatch**, which catches a typo before it costs anything.

Supply multiple RPC URLs if you can. Per spec §2, this chain's public RPC infra is new; the executor treats RPC failure as routine and rotates endpoints on error.

---

## Finishing the OpenSea resolver

`mapResponse()` in `src/resolvers/openseaResolver.js` needs one real API response for a Robinhood Chain drop. Specifically:

1. **Contract address** — which field, and how to pick the right one if `contracts` is an array spanning multiple chains.
2. **OpenSea's chain slug for Robinhood Chain** — not guessable (`robinhood`? `robinhood-chain`? `rhc`?). Needed to select from that array and to map to our config key.
3. **Mint price + units** — wei string, decimal ETH, or nested `{value, currency, decimals}`. Determines the BigInt conversion.
4. **Mint start time + format** — ISO8601 with offset, Unix seconds, or Unix millis. A seconds/millis mixup misfires by ~55 years; a missing timezone misfires by hours.
5. **Stage structure** — if presale/allowlist and public are separate stages, we must target the **public** one or every attempt reverts.

`validateNormalised()` already guards the expensive failure modes (bad address, implausible price, seconds-vs-millis) so a wrong mapping gets caught rather than fired.

---

## Commands

| Command | Behaviour |
|---|---|
| `/start` | Onboarding + wallet status. Prompts wallet import if no EVM wallet is stored. |
| `/importwallet <privateKey>` | Imports/replaces your external EVM wallet (used for Ethereum and every configured EVM chain). |
| `/wallet` | Balances per configured network. |
| `/newtarget` | Wizard: paste link → resolve → qty → fee budget → confirm card. `/cancel` aborts. |
| `/list` | Your targets, status, last execution error. |
| `/arm <id>` | Warns if underfunded, then schedules. |
| `/disarm <id>` | Cancels. Warns if already broadcasting (in-flight tx may still confirm). |
| `/withdraw <network> <address> [amount\|all]` | Native withdrawal. `all` sweeps minus gas. |

---

## How the snipe works (spec §5)

```
arm()     validate network/config/balance immediately — fail in chat, not at T=0
T-30s     pre-warm: open RPCs, keep-alive poll, probe mint fn, estimate gas,
          fetch nonce, simulate. Abort here on failure — no gas spent.
T=0       fire: broadcast, then re-broadcast on an interval WITHOUT waiting for
          confirmation, bumping maxPriorityFeePerGas each attempt (≥12.5% to
          satisfy replacement rules) until confirmed, budget-capped, or timeout.
after     persist Executions, update status, DM the result.
```

Two things worth knowing:

- **Nonce reuse across retries is intentional.** Every retry is a *replacement* of the same nonce, not an additional transaction. You cannot accidentally mint twice from the retry loop.
- **The budget ceiling is enforced before signing, not after.** `maxFeePerGas × gasLimit` must fit inside the user's budget or the attempt is refused.

Failure is reported with a cause: `budget` (fee too low), `reverted` (sold out / not live / allowlist), `timeout`, `rpc`.

---

## Security

Implemented:

- AES-256-GCM at rest, decrypted only inside a `withEvmKey()`-style closure at signing time, never returned to a handler, never logged. Per-record IV, and the user ID + chain are bound as AAD so ciphertext can't be moved between rows.
- Separate hot wallet per user (spec §7) — not a shared pool.
- Persisted per-user rate limits on `/newtarget` and `/withdraw`.
- Ownership-scoped queries: `/arm` and `/disarm` can only touch your own targets.
- `redactSecrets()` scrubs anything key-shaped from error output.

Not implemented (be honest about this before deploying): 2FA on withdrawals, withdrawal address allowlisting, hardware KMS (the master key is an env var), audit logging.

### Repo hygiene warning

This project lives at `/home/ami/bot`, and `/home/ami` is itself a git repo (`CYS-204`). `.gitignore` here covers `.env` and `data/`, but a `git add -A` from the **parent** directory may not respect it. Verify with `git status` before committing, or move this project outside `$HOME`.

---

## Known gaps

- Solana minting: stub.
- Magic Eden / Rarible: stubs.
- Flashbots/private relay (spec §5): not implemented — needs a Robinhood Chain relay endpoint, which I have no confirmed value for. Public mempool only.
- Single-process only: SQLite + in-memory schedule state means one instance. Multi-instance needs Postgres and a shared queue.
- No test suite yet. `npm run check` is syntax-only.

---

## Legal

Automated purchasing may violate marketplace terms of service. Importing private keys into automation carries operational and security risk. Both are your risk to assess.
