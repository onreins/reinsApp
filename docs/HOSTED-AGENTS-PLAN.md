# Hosted agents: build plan

*2026-10-02. Implements [HOSTED-AGENTS.md](HOSTED-AGENTS.md). Deployment borrows
from [beebots](https://github.com/imikerussell/beebots) (MIT): hardened compose
stack, test-gated image releases, decisions written before acting.*

**Goal.** "Create an agent" means an agent that trades. You pick a strategy, Reins
holds its trading key and runs it, and the contract still has the last word on
every trade.

**Scope.** Arc testnet, the USDC/EURC pair, two plain strategies. Mainnet,
AI-chosen moves and paper trading for the crypto templates come after.

**Estimate.** About 6–7 working days across three phases. Each phase ends with
something that runs and is tested.

## Status

**Phase 1: done (2026-10-02).** `runner/` holds the keystore, store, both
strategies, the loop, the gas keeper, the entry point (`npm run runner`) and a
key command (`npm run runner:key`), with 50+ tests including a run against a
local chain. A security review before any real key existed led to:
- agents checked against the deployment, and the key's owner, before binding;
- gas caps per key and per day, kept in the database;
- a send that may have gone out pausing the agent instead of retrying;
- keys tied to their address inside the encryption, and wiped when revoked.

First live run on Arc testnet: a hosted 50/50 agent,
[`0x3e14…813b`](https://explorer.testnet.arc.io/address/0x3e14214EaDc4e21324aEde221e4d94F908D9813b),
bought EURC in
[`0xd10a…be5b`](https://explorer.testnet.arc.io/tx/0xd10abb4a302351074f6872f75e57faffa111f8004ce60c190ff6344832c7be5b),
signed by the runner's key and capped at the agent's $0.50 per-trade limit.

**Audit, same day.** Operating it showed gaps, now closed:
- `npm run runner:admin`: `status`, and `resume` with a `--sent`/`--not-sent`
  verdict after a person checks a paused agent's trade, so a confirmed trade
  still counts toward a savings schedule;
- savings buys spaced from the last real trade, not the clock;
- an hour's backoff after a refused, skipped or failed trade (seen live: a $0.50
  buy refused because the tiny testnet pool was off the oracle, then a calm hold
  instead of a retry every five minutes);
- identical holds collapse into one row that counts its repeats;
- a Node version check before anything loads, and crash handling;
- the pool rebalance in the feed workflow, behind an `ARB_WALLET_KEY` secret.

**Testnet upkeep.** Each feed refresh leaves the testnet pool behind the oracle,
and agents' price bands then refuse honest trades. `npm run arb:testnet` closes
the gap; it should run right after each feed refresh (next: add it to the
feed workflow, with a key that holds both tokens).

**Next:** phase 2, the product surface.

---

## Phase 0: decisions (before or during phase 1)

| # | Decision | Suggestion | Blocks |
|---|---|---|---|
| D1 | Host | One small VPS running Docker Compose (Hetzner CX22 about €4/mo, or Hostinger KVM 2 about $9/mo); Railway if you'd rather not run a server | phase 3 |
| D2 | Who pays gas | Reins, from a gas wallet: about a cent a trade | phase 1.5 |
| D3 | First strategies | Euro savings and 50/50 balance | phase 1.3 |
| D4 | Off-site backups | Nightly copy to Cloudflare R2 or Backblaze B2 (free tier) | phase 3 |
| D5 | Legal | One conversation before anything touches mainnet | mainnet only |

---

## Phase 1: the runner, local, on testnet (3 days)

A new top-level `runner/` beside `bridge/` and `app/`, reusing the bridge's
executor, risk engine, signals and registry unchanged.

```
runner/
  index.js        start: config, store, keystore, loop, small HTTP API
  config.js       env in, validated settings out; refuses to start on bad config
  keystore.js     generate, encrypt, decrypt trading keys
  store.js        hosted agents and decisions, behind one interface
  brains/
    savings.js    euro savings
    balance.js    50/50 balance
    index.js      name → brain, and each brain's settings with bounds
  loop.js         one pass over every hosted agent
  gas.js          keeps each key's gas topped up
  api.js          /keys, /agents/:mandate/decisions, /health
```

### 1.1 Config and store

- `config.js` reads `RUNNER_MASTER_KEY` (32 bytes, hex), `RUNNER_SECRET` (shared
  with the app), `GAS_WALLET_KEY`, `APP_RPC`, `TICK_SECONDS` (default 300),
  `KILL_SWITCH_FILE`. A missing or malformed value stops startup with a reason.
- `store.js` uses Node's built-in SQLite (`node:sqlite`, no native build step)
  behind a small interface, so it can move to Postgres later without touching the
  loop. Two tables:
  - `hosted_agents(key_address PK, enc_key, iv, tag, strategy, settings_json, mandate NULL, issued_at, bound_at NULL, paused_at NULL)`
  - `decisions(id PK, mandate, at, strategy, outcome, side, asset, size_usd, rule, reason, tx_hash)`
- **Tests:** a decision round trip, and a migration that runs twice without harm.

### 1.2 Keystore

- `generate()` uses viem's `generatePrivateKey`. Keys are encrypted with
  AES-256-GCM under the master key, with a fresh random IV per key.
- A private key never leaves `keystore.js` except as a viem account for signing.
  It is never written to logs or returned by the API.
- Each key is bound at issuance to one strategy and its settings, so nobody can
  later point our key at a different strategy.
- A key not used by a create transaction within 24 hours is deleted.
- **Tests:** encrypt and decrypt round trip; a wrong master key fails loudly;
  tampered ciphertext fails (GCM tag); a log line containing a key is redacted.

### 1.3 Brains

Pure functions, with no network access: the agent's status and settings go in,
a decision with a reason comes out, in the shape `bridge/signals.js`
`fromDecision` already takes.

- **Euro savings** `{ buyUsd, everyHours, targetShare }`. Buys `buyUsd` of EURC
  each interval until EURC reaches `targetShare` of equity, then holds.
  Example reason: "Bought $5 of EURC: 32% of the agent, aiming for 50%".
- **50/50 balance** `{ target = 0.5, band = 0.05 }`. Holds inside the band. Outside it,
  trades back to the target, sized to the gap. Example reason: "Sold $3 of EURC:
  it had grown to 57%, outside 45–55%".
- Every setting has bounds, checked when the key is issued.
- **Tests:** each branch (below, inside and above the band; target reached; not
  yet time), sizing at the edges, a zero balance, a frozen agent.

### 1.4 The loop

Every `TICK_SECONDS`:

1. **Find agents.** For each key with a `mandate`, read the agent's current
   trading key. If it is no longer ours (revoked or replaced), mark it paused and
   skip it from then on. Unbound keys are matched to new agents through the
   factory's `MandateCreated` events, using the existing indexer and snapshot.
2. **Decide.** Status from `MandateClient`, then the brain, then `fromDecision`.
3. **Write first, then act.** The decision is recorded as `pending` before the
   executor runs, then updated with the outcome: traded, held, refused, risk,
   skipped or unknown. The executor never resends an unconfirmed trade, which it
   already guarantees.
4. **Isolate failures.** One agent throwing is logged and recorded. The pass
   carries on.
5. **Kill switch.** If `KILL_SWITCH_FILE` exists, the loop records "paused by
   kill switch" and sends nothing.

- **Tests:** on the local Hardhat chain (as `test/arena.test.js` does), create an
  agent whose trading key came from the keystore, run one pass, and see the trade
  and its decision record. Revoke the key and see the next pass skip it. A brain
  that throws doesn't stop the other agent. With the kill switch file present,
  nothing is sent.

### 1.5 Gas keeper

- Runs after each pass. Any key below $0.10 of USDC is topped up to $0.50 from
  the gas wallet, with a daily cap on total top-ups.
- If the gas wallet runs low, it logs and raises an alert (phase 3), and agents
  hold rather than fail.
- **Tests:** top-up when low, nothing when above, and the daily cap stops it.

### Phase 1 is done when

`npm run runner` on testnet trades a real test agent through both strategies,
every decision is in SQLite with a plain reason, and the full test suite passes.

---

## Phase 2: the product (2 days)

### 2.1 Runner API (internal)

- `POST /keys {strategy, settings}`, authorised by `RUNNER_SECRET`. It returns
  `{address}` only, and is rate-limited per caller and in total.
- `GET /agents/:mandate/decisions?limit=50` is public, since decisions are the
  transparency feature.
- `GET /health` reports the last pass time, agents run, gas wallet balance and
  the kill switch state.

### 2.2 App routes (`app/server.js`)

- `POST /api/hosted/key` forwards to the runner with the secret, so the browser
  never sees it, and validates strategy and settings at the boundary.
- `GET /api/mandate/:address/decisions` is cached for a few seconds.

### 2.3 Create page, step 3 "Who trades"

- New first option: **Let Reins run it**, with a strategy picker for Euro savings
  and 50/50 balance. Each shows its two or three settings as sliders, with the
  same plain readouts as the limits ("Buys $5 of EURC every day until it's half
  the agent").
- On create, the page asks for a hosted key, then creates the agent with that
  address as the trading key. Nothing else changes in the signing flow.
- The agent card adds "Run by Reins · 50/50 balance" and "Reins pays the gas".

### 2.4 Agent page

- Under the hero: "Run by Reins · 50/50 balance", with the strategy's settings.
- A **Decisions** feed with every pass's outcome and reason, including holds.
  Holds are what make it feel alive and explainable.
- **Pause:** revokes the key on-chain with the existing `setAgent(0)` action.
  **Resume** asks the runner for a fresh key bound to the same strategy and sets it.

### 2.5 Stretch: describe it in a sentence

A sentence ("save into euros slowly, never risk more than 5%") is turned by the
strategy chat's existing LLM setup into a name, a strategy, its settings and the
limits on the sliders. The result fills in the create page; you can still change
anything before signing.

### Phase 2 is done when

A new user on testnet goes from the create page to an agent that Reins is
trading, sees its decisions on the agent page, and can pause it, without
touching a key.

---

## Phase 3: deploy (1 day, once D1 and D4 are settled)

### 3.1 Images and stack (after beebots)

- `runner/Dockerfile` on `node:24-slim`, running as a non-root user.
- `deploy/docker-compose.yml` has three services: `runner`, `web` (Caddy with
  automatic HTTPS, the only service with published ports) and `backup`. Every
  service runs with `cap_drop: [ALL]` and `no-new-privileges`, with log rotation
  and named volumes.
- CI: `.github/workflows/runner.yml` runs tests, then builds the image and pushes
  it to GHCR. A release tag publishes `:latest` and a push to master publishes
  `:edge`, so the server only ever runs released code.

### 3.2 Secrets

`RUNNER_MASTER_KEY`, `RUNNER_SECRET`, `GAS_WALLET_KEY` and `APP_RPC` live in the
host's environment, never in the repo or the image. `RUNNER_SECRET` and the
runner's URL also go into Vercel for the app.

### 3.3 Backups and monitoring

- A nightly consistent SQLite copy is pushed off the server (D4), keeping 14 days.
- An uptime check on `/health` (UptimeRobot free tier) alerts if no pass ran in
  15 minutes or the gas wallet is under $5.
- Alerts go to one webhook: Discord, Slack or Telegram.

### 3.4 Runbook (`docs/RUNNER-OPS.md`)

How to stop everything (touch the kill switch file), restore from a backup,
rotate the master key, refill the gas wallet, and what each alert means.

### Phase 3 is done when

The runner trades on the server, survives a restart and a redeploy without
duplicate trades, the restore from backup has been tried once, and the alerts fire
in a drill.

---

## After that

1. **AI-picked moves** (the beebots idea, done our way). A model chooses from a
   menu of moves that are legal right now. It isn't called when only one move is
   legal, there is a hard daily spend cap, and the risk engine and the contract
   still decide.
2. **Paper mode for the crypto templates** on real BTC, ETH and SOL prices,
   labelled as paper, building their records until those assets list on Arc.
3. **Owner alerts** when an agent hits its sells-only line or freezes.
4. **Mainnet**, after D5.
5. **Thesis rounds for the Charts page.** Every 4 hours (00:00, 04:00, … UTC)
   the runner reads the same 24-hour exchange stats the page uses and writes a
   thesis per coin plus the round's hot and cooling lists to `/api/thesis`. The
   page reads that in place of its rule-based sample (`app/public/markets.js`,
   labelled "Sample" on screen) and keeps each round's picks fixed for its four
   hours, as it does now. A paper record per hot pick (price at the round's
   start, then 4h, 24h and 7d later) gives the hot list a track record before
   anyone backs it with money.

## Risks

| Risk | Answer |
|---|---|
| Runner compromised | Keys trade only; limits and stop-loss bound the damage; owners revoke on-chain; kill switch; master key outside the server |
| Duplicate trades after a crash | Decisions written before acting; the executor never resends an unconfirmed trade |
| RPC rate limits | Ticks every 5 minutes, the indexer snapshot, `APP_RPC` for a paid endpoint |
| Gas wallet empty | Alert under $5; agents hold rather than fail |
| `node:sqlite` is experimental in Node 24 | Behind the store interface; better-sqlite3 or Postgres drop in |
| Strategies look dull on USDC/EURC | Plain reasons for every hold, paper mode for the crypto templates, tokenized stocks later |
