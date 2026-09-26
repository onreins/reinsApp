# Mandate — product sketch

*Drafted 2026-09-26. The consumer product, not the plumbing.*

## The one line

**Run a stock strategy — or follow someone else's — without ever handing over
your money, and with a track record nobody can fake.**

## The three things a user gets that they cannot get today

1. **Your rules are code, not promises.** "Never more than 30% in one name."
   "Sell half if it drops 10%." "Max $500 a trade." A broker's stop-loss is an
   instruction you hope gets honoured. Here it is a condition the contract
   checks before any money moves, and a trade that breaks it simply reverts.

2. **Automation that is finally economic when you are small.** A trade on Arc
   costs about a cent. Daily dollar-cost averaging, continuous rebalancing and
   real stop-losses stop being things only large accounts can afford.

3. **Track records that cannot be faked, from people who cannot rob you.**
   Every trade is on-chain. Follow a strategy and your money never leaves your
   own contract — the operator gets a key that can trade inside your limits and
   has no function that withdraws. Revoke it and it stops next block.

## The structural idea, and why it is different

Everyone else in this space **pools**. You deposit into a shared vault, receive
a share token, and the manager trades the pot on their terms.

We do not pool. Each user has their own Mandate holding their own money. To
follow a strategy you point your mandate's agent key at that strategy's
operator — **your** rules still bind, on top of whatever the strategy would do.

| | pooled vault | API copy-trading | **Mandate** |
|---|---|---|---|
| Who holds the money | the vault | you | **you** |
| Whose rules bind | the manager's | none | **yours** |
| Can the operator withdraw | yes, by design | often yes | **no function exists** |
| Personal loss limit | no | no | **yes, enforced** |
| Exit | redeem, subject to terms | revoke keys | **instant, unilateral** |

The pitch in one sentence: *you are not giving them your money, you are letting
them press buttons on your account — and only the buttons you allow.*

## Competitors, and what is actually taken

Scanned 2026-09-26 from public sources.

### On-chain asset management — old, small, crypto-only

| | TVL | model |
|---|---|---|
| Enzyme (ex-Melon) | ~$85M | pooled vaults, 350+ assets, running since 2019 |
| dHEDGE | ~$40M | pooled vaults on L2s, manager track records |

Both do non-custodial management with transparent records. Both are **pooled**,
**crypto-only**, and after five or six years the whole category is ~$125M. That
is a warning as much as an opening: "copy a manager on-chain" has been possible
for years and has not broken out.

### Hyperliquid vaults — the format that is working

226 vaults, **~$268M TVL**, largest single vault ~$100M. Hyperliquid's open
vaults give "public, provable track records and standardized entry/exit
controls by the protocol, protecting depositors." That is the closest thing to
our thesis with genuine traction, and it validates the core bet: people will
follow a strategy when the record is provable and the protocol protects them.

It is also **perps only**, **pooled**, and the protections are Hyperliquid's
standard ones — not rules each depositor sets for themselves.

### AI agents in DeFi — real scale, wrong asset

- **Giza**: autonomous agents rebalancing lending positions; **$3.96B of
  agentic volume** by March 2026.
- **Almanak**: agents building verifiable, deterministic strategies.
- **Alphio, HyperAgent**: copy-trading and AI bots mirroring Hyperliquid.

Well funded and shipping. None touch equities, and the copy-trading ones work
by holding your keys or API access — you trust the bot not to ruin you, rather
than being protected from it.

### Tokenized stock automation — the actual gap

- **Pionex**: grid, DCA and rebalancing bots across 280+ tokenized instruments
  — but a **custodial exchange**. Your stocks sit with them.
- **Stocklane**: a hackathon DCA + portfolio app for xStocks on Solana.
- One **hackathon AI agent** trading xStocks non-custodially via Jupiter.

That is the whole field. Nobody runs rules-enforced, segregated, verifiable
stock strategies. The assets only just arrived, and on Arc they have not
arrived at all yet.

### What we would be first at

Rules-enforced automation on **tokenized equities**, on **institutional rails**
(Arc validators include BlackRock, DTCC and the NYSE's parent), with
**segregated per-user mandates** instead of a pool. Each of those three is
taken individually. The combination is not.

## The product

### Screen 1 — Leaderboard

Strategies ranked by verified return. Each row: name, return since funding,
worst drawdown, age, trades, followers, and the rules it runs under. Read from
chain state, no database. **Exists already** (`arena/`); needs follower count
and drawdown.

### Screen 2 — Strategy

Its equity curve, every trade with a transaction link, the rules it binds
itself to, who operates it, how long it has run. The honesty surface: a
three-day-old strategy up 40% should look obviously riskier than a nine-month
one up 12%.

### Screen 3 — Your mandate

Balance, holdings, the rules you set, headroom before your loss limit, and an
activity feed in plain language ("refused: the trade was larger than your $500
limit"). One unmissable **Withdraw everything** button that needs nobody's
permission.

### Screen 4 — Create

The rule builder. Plain language in, on-chain constraints out:

> "Put in $2,000. Only SPYx and NVDAx. Never more than $200 at once. Stop if I
> lose 10%. Run for 90 days."

becomes `maxTradeValue`, `maxDrawdownBps`, `maxSlippageBps`, `expiresAt` and
the allowed-asset list — the five rules the contract already enforces.

### Two ways in

- **Run your own rules.** A schedule ("$20 of NVDAx every day") or an LLM agent
  you brief in words, driving the MCP tools we already have.
- **Follow a strategy.** Point your mandate at an operator. Your limits still
  bind. Revoke instantly.

## Three tiers, and the line that must not be crossed

The open model is the trust story. Most people will not write their own rules,
so there has to be a way in that feels managed. There are three versions of
that and only two of them are available to us.

| | who decides a trade | who holds the assets | what we are | licence |
|---|---|---|---|---|
| **1. Open** | the user's own rule or agent | the user | software | no |
| **2. Autopilot** | the user's configured template | the user | software | no |
| **3. A manager** | a third party, licensed | the user | a venue | **theirs** |
| ~~4. We manage it~~ | **us** | **us** | an asset manager | **ours — no** |

**Tier 1 — Open.** You write the rules, you hold the tokens, any agent runs
inside them. Built.

**Tier 2 — Autopilot.** Preset strategies as configurable templates: dollar-cost
average, rebalance to target weights, trailing stop. The user picks and sets the
parameters; our software executes that instruction deterministically. It feels
managed — you stop thinking about it — but **we exercise no discretion** and
never hold the assets. This is also where a clean subscription fee lives,
instead of a performance fee on somebody else's money.

**Tier 3 — Licensed managers as the supply side.** Rather than us getting
registered, regulated managers run strategies on our rails. They bring the
licence; we bring segregated mandates and an unfakeable record. It removes
*their* custody risk too, which makes it an easy pitch. We take a platform cut
and remain software.

**Tier 4 is the trap.** Taking custody and making the decisions for a fee makes
us a discretionary asset manager: a licence in nearly every jurisdiction, the
one constraint the company was founded to avoid, and the end of the sentence
"nobody can take your money" — because we could.

### The grey area, stated honestly

The line between tier 2 and tier 3 is whether **we** decide or **the user's
configured rule** decides. Pointing an agent we control at a user's mandate and
letting it choose trades is plausibly discretionary management in several
jurisdictions **even with no custody**. Not holding the assets lowers the risk;
it does not automatically exempt us. This needs one conversation with a lawyer
before anything ships described as managed.

### How do the existing vaults get away with it? They do not

Worth knowing, because the obvious move is to copy them and it does not work
for us.

- **Hyperliquid geofences the United States entirely.** US persons are
  Restricted Persons, enforced by geoblocking, with VPN workarounds forbidden
  in the terms. Its own user vaults are described as actively managed funds
  with **no regulatory wrapper**.
- **The liability is pushed down onto managers.** The protocol's posture is
  "we are neutral software, the manager is the regulated party" — and nobody
  checks whether the manager is registered. One analysis states outright that a
  trader in New York or London running a public pool on dHEDGE is likely
  committing a criminal offence by providing unauthorised financial services.

So the playbook is: incorporate offshore, geoblock the US, call yourself a
protocol, and let unregistered managers carry a risk they mostly do not know
they are carrying.

**That cover does not extend to our asset class.** The grey zone exists because
the status of crypto assets is unsettled. A tokenized Apple share is not
unsettled: it is a security, its issuer is regulated, and managing it for other
people is investment advice with no argument available.

Which is exactly why this is an opening rather than an obstacle. Every
incumbent in on-chain asset management is structurally locked out of regulated
assets — their design assumes the grey zone. The SEC opened a compliant lane in
September 2026 (Tokenized Securities Venues trading through permissioned AMMs),
and Arc's validators are DTCC, BlackRock and the NYSE's parent. Building a
grey-zone product on the most institutionally validated chain in existence
would be a contradiction.

**The compliance lane is the moat, not the tax.** It is the thing dHEDGE and
Hyperliquid cannot follow us into.

Practical consequences:

1. Tiers 1 and 2 are genuinely not what they do. They have managers exercising
   discretion over pooled funds; we have users configuring rules over their own
   segregated assets — closer to a limit order than to a fund. Defend that
   distinction in the design instead of blurring it.
2. Tier 3 works because the manager brings a licence we can actually verify,
   which is a selling point to regulated managers rather than a burden.
3. The US geoblock is not our decision anyway: xStocks are already not offered
   to US persons. The issuer imposes it on everyone.

### Regardless of tiering: run our own strategy, publicly

We should operate a strategy in the arena with our own money from day one. It
solves the empty-leaderboard problem, and it is not managing anyone's money —
it is a public track record, which is the most credible marketing this product
can have.

## What already exists

| piece | state |
|---|---|
| Mandate contract + factory | done; 252 tests, reviewed, live on Arc testnet |
| Holding transfer-restricted securities | done 2026-09-26 |
| Uniswap v4 venue adapter | done, proven against mainnet state |
| Leaderboard reading chain state | done (`arena/`) |
| Agent surface (SDK + MCP tools) | done |
| Consumer app | **not started** — this is the work |
| Follow-a-strategy flow | **not started** |
| Equity assets on Arc | **waiting on the ecosystem** |

## The blocking dependency, stated plainly

Arc has 32 Chainlink feeds and **not one equity**. A Mandate cannot price SPYx
until Chainlink adds equity feeds to Arc or Pyth deploys there. The tokens
arriving is not enough; the oracle has to arrive too.

That is the single most important question to put to Circle, and a better one
than "when are stocks coming".

Until then we build the whole app against a simulated equity on Arc testnet
using `PinnedFeed`, so the day the real ones land we add a token address, a
feed and a route — config, not code.

## Open questions worth deciding early

1. **How does a strategy operator get paid?** They cannot take funds, which is
   the whole point. A capped performance fee claimable to a fixed address is a
   contract addition; an off-chain subscription is not. This is the business
   model for the supply side and it is unresolved.
2. **Is "follow this strategy" regulated?** Non-custodial and user-chosen is a
   far safer posture than managing money, but this needs one real conversation,
   not a guess from an engineer.
3. **Market hours.** Equity feeds keep New York hours and publish nothing at
   weekends, while the tokens trade 24/7. Our `maxPriceAge` rule already makes
   a mandate refuse to trade on a stale price — correct behaviour, and worth
   presenting as a feature rather than a limitation.
4. **Which chain does v1 launch on?** Arc has the rails and the partners but no
   assets yet. Solana has $502M of xStocks today and would mean a Rust rewrite.
   Staying on Arc is a bet on timing.

## The first thing to build

The app, not the plumbing — because the app is what anyone will judge this by,
and every contract it needs already exists.
