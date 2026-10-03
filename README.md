# Reins

**Hand an AI agent the reins, never the keys.**

Reins lets anyone run an AI trading agent on [Arc](https://arc.io) without
trusting it with their money. The agent's USDC sits in a smart contract, a
**Mandate**, that enforces the rules its owner set. The agent can trade inside
those rules and nothing else: it can't move money out, can't trade too big,
can't take a bad price, and can't lose past the limit. The owner can take
everything back at any time.

- **App:** [app.reins.one](https://app.reins.one), Arc testnet
- **Site:** [reins.one](https://reins.one), in the [`reins`](https://github.com/onreins/reins) repo
- **Plain-language walkthrough:** [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)

This answers item 12 of Arc's
[Request for Builders](https://www.arc.io/blog/the-unfinished-business-of-finance-machine-commerce-and-global-money),
"Money with a Mandate".

---

## What's in the app

| Page | What it does |
|---|---|
| **Agents** | Every agent on the chain, ranked by return. Read straight from on-chain events: no database, nothing to take on trust. |
| **An agent's page** | Its money, holdings, rules, risk headroom and history, including the trades it tried and was refused, each linking to the explorer. |
| **Create agent** | Pick the rules in plain units (largest trade, loss limit, price band, expiry), see exactly what the contract will hold, and sign with your own wallet. Fund it with USDC you hold, or **buy USDC with a card** without leaving the page. |
| **Charts** | A full-screen market terminal: every market on Binance, Coinbase and Hyperliquid (over 3,500) with live prices, a full chart with indicators and drawing tools, and under it each coin's agent thesis, with the round's hot list beside it. The thesis is a rule-based sample for now; hosted agents will write it every 4 hours. Charts by LuxAlgo's open-source [Vela](https://velacharts.dev). |
| **Strategy chat** | Describe a trading idea in plain words. An AI turns it into a strict strategy format and the app backtests it on real prices: any timeframe from 1 minute to 1 day, fees counted, checked half by half. |

Your wallet signs every transaction. The app never sees a key and never holds
funds.

## How a Mandate protects the money

A Mandate holds the agent's USDC and enforces, on every trade:

- **only allowed assets**, through one exchange the owner chose
- **a size limit** on every trade
- **fair prices**: every fill is checked against Chainlink; worse than the
  price band and it reverts
- **a loss limit**: a trade that would breach it reverts, and *anyone* can
  freeze the Mandate if the market alone pushes it past the line (a public
  stop-loss)
- **an expiry**, and **no way for the agent to move money out**

The owner can withdraw everything, swap the agent or revoke it at any time, and
that exit never depends on an oracle being healthy. The rules are fixed at
creation; nobody can loosen them later, including the owner.

### Proven against Arc mainnet, without spending anything

```bash
npm run build && npm run sim:mainnet -- 10
```

One `eth_call` against live mainnet state: a Mandate is deployed inside the
call, funded, and its agent trades $10 of USDC into EURC and back through the
real Uniswap v4 pool, checked by the real Chainlink feed. Nothing is broadcast.

```
  Chainlink EURC/USD   $1.1385
  bought               8.7775 EURC for $10.00  (fill $1.1393 per EURC, 0.068% vs oracle)
  equity at the end    $19.9900  (round trip cost $0.0100)
```

### Running live on Arc testnet

| contract | address |
|---|---|
| `MandateFactory` | [`0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82`](https://explorer.testnet.arc.io/address/0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82) |
| `UniswapV4Venue` | [`0x007d5ad07b7a97fefcbd4302dfeafc11d8485052`](https://explorer.testnet.arc.io/address/0x007d5ad07b7a97fefcbd4302dfeafc11d8485052) |
| a live mandate | [`0x991b8687aca6Acd6b92438bb4cE22866827bD632`](https://explorer.testnet.arc.io/address/0x991b8687aca6Acd6b92438bb4cE22866827bD632) |

An agent bought euros through the real Uniswap v4 pool at 0.45% from the
oracle. The Mandate then refused a trade over its size limit, a trade into an
asset it was never granted, a trade too large for the pool to price fairly, and
a trade signed by a key that isn't its agent. A stranger froze it when it fell
through its floor, and the owner withdrew mid-strategy. Each refusal was
broadcast on purpose, so it exists on-chain as a transaction you can open.
**[Every step, with transaction links →](docs/live-run/TESTNET-RUN.md)**

Two things differ from mainnet: Chainlink publishes no feeds to Arc testnet, so
the Mandate reads a stand-in carrying the mainnet answer, and testnet had no
USDC/EURC pool, so we created and funded one. Neither touches the Mandate
contract.

## Plug in any AI agent

```bash
MANDATE_ADDRESS=0x… MANDATE_AGENT_KEY=0x… npm run mandate:mcp
```

An MCP server gives any MCP-speaking agent (Claude and others) three tools:
`mandate_status` (money, holdings, rules, loss headroom), `mandate_price` and
`mandate_trade`. A refused trade comes back as the rule it broke and why, so
the agent adjusts instead of retrying blindly. `mandate/sdk.js` offers the same
from JavaScript, and `agents/fx-reversion.js` is a reference agent built on it
(a worked example, **not a profitable strategy**: see
[research/FINDINGS.md](research/FINDINGS.md)).

## The strategy chat

Plain words in, a validated strategy and an honest backtest out.

- **A strict format, not code.** The AI only ever proposes a strategy as data
  (zod-validated in `app/strategy/spec.js`): price, SMA, EMA, RSI, N-candle
  highs and lows, compared four ways, as rules or DCA. Anything outside it is
  refused, and a spec whose timeframes don't match what the person wrote
  ("50-day" built as 50 minutes) is sent back to be fixed.
- **Every number comes from the backtester, never from the AI.** Signals are
  read at a candle's close and filled at the next open; stops fill at their
  level or at the gap; every fill pays the chosen fee (0.05%, 0.1% or 0.3%).
- **Any timeframe, mixed.** 1m, 5m, 15m, 1h, 4h or 1d, and each average can sit
  on its own timeframe ("the 100-minute EMA crosses the 50-day average"). A
  slower series is only read once its candle has closed, so nothing sees the
  future.
- **Real prices.** Binance candles for BTC, ETH, SOL, XRP, BNB, DOGE, AVAX and
  LINK since 2019: daily in `app/data/prices.json`, 1-minute (~30M candles,
  457 MB) outside git, built by `scripts/export-candles.py`. A full 7-year
  minute backtest takes ~0.3 s on a worker thread, so it never stalls the
  server.
- **Honest reports.** Return against simply holding, worst drop, fees paid, and
  a consistency check that flags a result resting on one half of the period.
  Each reply that changes a strategy keeps that version, so you can go back.
- **Free AI, rotated.** Any OpenAI-compatible endpoint; today four Cloudflare
  Workers AI models in turn, so a limited or busy one hands the same
  conversation to the next. With none available, an offline builder answers.

These coins aren't tradeable on Arc yet (only USDC/EURC has a deep pool), so a
chat strategy is a study until pools launch; the app says so. Details:
[app/strategy/README.md](app/strategy/README.md).

## Card funding

The create flow can buy USDC on Arc with a debit card, Apple Pay or Google Pay
through Circle's [Onramp Kit](https://docs.arc.io/app-kit/onramp). The USDC goes
to the person's own wallet, and the usual deposit step moves it into their
agent; card details and identity checks stay with Circle. Our server mints
30-minute sessions with a key the browser never sees (`app/onramp.js`), and the
page confirms arrival by reading the wallet's balance on-chain rather than
trusting the widget's events. It runs in Circle's sandbox until a key is set.

---

## Running it

```bash
npm install && npm run build      # compile the contracts
npm run chain                     # terminal 1: a local chain
npm test                          # terminal 2: 400+ tests
npm run app                       # the app on http://localhost:4100
```

The app reads `.env` (gitignored). Everything is optional; without a setting,
that feature switches itself off.

| Setting | What it does |
|---|---|
| `APP_NETWORK`, `APP_RPC` | Which Arc network and RPC the app reads (default: testnet, public RPC) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | The chat's AI: any OpenAI-compatible endpoint |
| `LLM_FALLBACK_MODELS`, `LLM2_BASE_URL`… | More models and providers to rotate to when one is limited |
| `CANDLES_DIR` | Where the 1-minute price files live (default `data/candles`) |
| `ONRAMP_API_KEY`, `ONRAMP_ENV`, `ONRAMP_REFERRER_DOMAIN` | Card funding through Circle (sandbox by default) |
| `TRUST_PROXY` | Proxy hops to trust behind a host like Vercel, so rate limits see real visitors |

Minute prices, if you want minute and hourly strategies locally:

```bash
freqtrade download-data --exchange binance --trading-mode spot --timeframes 1m --timerange 20190101- --pairs BTC/USDT ETH/USDT ...
python scripts/export-candles.py <freqtrade>/user_data/data/binance
```

### Deploying

The app runs on Vercel: pages from `app/public` on the CDN, the API as one
function (`api/index.js` wraps the same Express app). `vercel.json` and
`.vercelignore` decide what ships; keys stay in Vercel's settings. The 1-minute
prices are too large for a function, so the hosted app runs daily strategies
only until they move to object storage. A build from GitHub needs the two
compiled contract files the API loads (`build/Mandate.json`,
`build/MandateFactory.json`), which `npm run build` produces.

## Layout

```
contracts/      Mandate + factory, UniswapV4Venue, price feeds (and earlier work)
mandate/        SDK and MCP server for agents
agents/         reference agent
app/            the app: Express server, pages, strategy chat, card funding
  strategy/     spec, backtester, minute candles, worker pool, chat, model rotation
  public/       the pages (Agents, agent page, Create agent, Strategy chat, Charts)
api/            the app as a Vercel function
arena/          leaderboard and returns, read from chain events
bridge/         risk engine behind an agent's page
scripts/        build, deploy, simulate, price exports
research/       strategy research and findings
site/           reins.one (published separately to the reins repo)
docs/           how it works, live-run evidence, handoff, product notes
test/           400+ tests, most of them adversarial
```

## Honest limits

- **Testnet today.** Nothing is deployed to mainnet yet; `npm run deploy:mandate
  -- --dry-run` estimates ~$0.10 of gas when it is.
- **One deep pool.** Only USDC/EURC is liquid on Arc mainnet, so a real agent is
  an FX agent until more pools launch.
- **Not formally audited.** An adversarial security review ran before any
  deployment and its findings are fixed with regression tests (a broken price
  feed blocking partial withdrawals, a mid-swap stop-loss trigger, rounding on
  dust trades), but a review is not an audit.
- **Backtests are history.** They count fees and avoid lookahead, but past
  results don't promise future ones, and nothing in Reins is investment advice.

## Arc notes

Things that bit, or would have:

- **Native USDC is 18 decimals; the ERC-20 view of the same balance is 6.** One
  balance, not two.
- **Block timestamps are only non-decreasing.** Deadlines that need guaranteed
  progress use block numbers.
- **The public RPC refuses `eth_getLogs` ranges of 10,000+ blocks** and rejects
  multi-event topic filters. Every log query here pages and filters locally.
- **viem caches `getBlockNumber` for ~4 s.** At 0.5 s blocks that hides ~8
  blocks. Head is read uncached.
- **Base fee floor is 20 gwei**; transactions below it are dropped silently.

| | mainnet | testnet |
|---|---|---|
| chain id | 5042 | 5042002 |
| USDC | `0x3600…0000` | `0x3600…0000` |

## Earlier work

Reins grew out of **Verdict**, a neutral evaluator for payments between AI
agents (ERC-8183), with an arbiter API for any escrow and compute sold over
x402 through Circle Gateway. It still runs on Arc testnet, and its code lives in
`arbiter/`, `evaluator/`, `service/` and `src/`. The full write-up is in
[docs/VERDICT.md](docs/VERDICT.md).

## License

MIT. The Charts page bundles [Vela](https://velacharts.dev) by LuxAlgo
(Apache-2.0) into `app/public/vendor/vela-workspace.js`; rebuild it with
`npm run build:charts`.
