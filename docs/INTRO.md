# Reins — who we are and what we're building

**Site:** https://reins.one · **App:** https://app.reins.one · **X:** https://x.com/onreins

## One line

Reins is where AI agents trade under rules. Hand an agent a budget it cannot run off with.

## Short intro

We're building Reins, on Arc. A Reins agent is a smart contract that holds your USDC and trades it inside rules you set: a cap on every trade, a loss limit, a price band checked against the oracle, and a fixed list of allowed assets. The rules are set once when the agent is created and nobody can loosen them later, not the AI, not us, not even you. The agent has no function that withdraws. You can pull your money out at any time, mid-strategy, without asking anyone.

Plug in any AI or trading bot and it gets exactly three things: status, prices, and trades. When it asks for something the rules forbid, the contract says no in plain words and the agent adjusts. Every trade, and every refused trade, is on-chain for anyone to check.

It's live on Arc testnet today, trading USDC/EURC through Uniswap v4 at about a cent a trade. Tokenized stocks are coming to Arc next, and that's where this goes.

Follow along at https://x.com/onreins and try it at https://app.reins.one.

## Longer intro

Ask anyone who kept money on Celsius, FTX, or a quiet vault: the failure was never bad trading. It was not knowing where the money was until it was gone. Most pools still can't show you how they trade or where your funds sit.

Reins fixes that by not pooling. Each user has their own contract, holding their own money, with their own rules written in code:

- **Cap every trade.** Anything over the cap reverts.
- **Stop at your loss limit.** If the market pushes the agent through its floor, anyone on the internet can freeze it. You don't have to be awake.
- **Only the assets you allow exist to it.** Everything else refuses on contact.
- **Every fill is checked against the oracle.** A price worse than your band reverts the whole trade, so the classic drain into a rigged pool simply doesn't execute.
- **Leave whenever.** Withdrawing asks nobody and doesn't depend on an oracle being healthy.

To follow someone else's strategy, you point your agent's key at their operator. Your rules still bind on top of theirs. They can press the buttons you allow on your account, and nothing else. Revoke the key and it stops next block. That gives strategies a track record nobody can fake, from operators who cannot rob you.

Reins never has custody of, or access to, user funds. Our pages read the chain directly, so every number can be checked against the explorer.

Built on Arc, where gas is paid in USDC, with Uniswap for routing, Chainlink for prices, and an MCP server so any AI (Claude and others) can drive an agent out of the box.

- Site: https://reins.one
- App (Arc testnet): https://app.reins.one
- X: https://x.com/onreins

*Running on Arc testnet. Not investment advice. Automated strategies can lose money up to the loss limit their agent sets.*

## Intro to admins (tokenized-stocks positioning)

Hi all, I'm [name], building **Reins** on Arc. We're positioning for the tokenized stocks coming to Arc: rules-enforced, non-custodial stock strategies that an AI agent can run for you.

Here's the idea. You deposit USDC into your own contract and hand an agent a key that can only trade inside rules you set. "Only SPYx and NVDAx. Never more than $200 at once. Stop if I lose 10%. Run for 90 days." Those become on-chain constraints the contract checks before any money moves. A trade that breaks one simply reverts. The agent has no function that withdraws, and you can pull everything out any time, mid-strategy, without asking anyone.

Why Arc. Gas in USDC, trades for about a cent, and validators like BlackRock, DTCC and the NYSE's parent. That's the right venue for equities, and nobody is doing rules-enforced, segregated, verifiable stock automation there yet. Custodial exchanges run stock bots, but your stocks sit with them. We don't pool and we never hold funds. Every trade, and every refused trade, is on-chain for anyone to check, which also gives strategies a track record nobody can fake.

Where we are. Live on Arc testnet trading USDC/EURC through Uniswap v4, checked against Chainlink, with 324 tests behind it. An MCP server lets any AI (Claude and others) drive an agent out of the box. We're building the full app against a simulated equity on testnet so the day real stock tokens and their price feeds land, we add a token address, a feed and a route. Config, not code.

One question for the team: equity tokens arriving isn't enough on its own, the agent needs an equity price feed on Arc to price fills and enforce loss limits. Is there a timeline for Chainlink or Pyth equity feeds on Arc?

Site: https://reins.one
App: https://app.reins.one
X: https://x.com/onreins

## Intro to admins (what we've built so far)

Hi all, I'm [name], building **Reins** on Arc. Quick rundown of what we've actually built so far.

**The Mandate contract.** A smart contract that holds a user's USDC and lets an agent key trade it only inside rules fixed at creation: a per-trade cap, a loss limit, an oracle price band, a fixed list of allowed assets, and an expiry. The agent has no withdraw function. The owner can withdraw everything, swap the agent or revoke it at any time, and that exit never depends on an oracle being healthy. Anyone can freeze a mandate that falls through its loss floor, so it works as a public stop-loss. Plus a Uniswap v4 adapter so trades route through the real PoolManager with every fill checked against Chainlink.

**Deployed and exercised on Arc testnet.** Factory at 0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82, venue at 0x007d5ad07b7a97fefcbd4302dfeafc11d8485052. In the live run an agent bought EURC through Uniswap v4 at 0.45% from the oracle, then the mandate refused a trade over its size limit, a trade into an asset it wasn't granted, a trade too large for the pool to price fairly, and a trade signed by the wrong key. A stranger froze it when it fell through its floor, and the owner withdrew mid-strategy. Every refusal was broadcast on purpose so it exists as a transaction you can open, not a simulation.

**Proven against Arc mainnet without spending anything.** One eth_call against live mainnet state deploys a mandate, funds it, and round-trips $10 USDC into EURC through the real pool, checked by the real Chainlink feed. Round trip cost about a cent.

**An agent surface.** An MCP server gives any MCP-speaking AI (Claude and others) three tools: status, price, trade. A refused trade comes back as the rule it broke and why, so the agent adjusts instead of retrying. There's a JS SDK and a reference agent built on it.

**A bridge for existing bots.** Any strategy brain (a freqtrade webhook, for example) posts signals, the bridge turns each into at most one trade sized inside the mandate's cap, through a risk engine. Signals for assets not yet on Arc are logged as shadow trades, so a strategy has a paper record by the time the asset lists.

**The app, live at app.reins.one.** Leaderboard of agents ranked by verified return read straight from chain, an agent page with holdings, trades and rules, a create flow where the browser signs and our server never holds a key, Circle Onramp to buy USDC with a card, and a strategy chat that turns plain language into on-chain rules and backtests it.

**Earlier work on the same rails.** Verdict, a neutral evaluator for ERC-8183 agent jobs that re-runs delivered code against agreed tests and releases or refunds escrow, also live on Arc testnet with settled jobs. And x402 pay-per-call metering with USDC payment channels. The whole stack sits on about 400 tests, and an adversarial security review ran before any deployment.

Site: https://reins.one · App: https://app.reins.one · X: https://x.com/onreins

Next is tokenized stocks. The app is built against a simulated equity on testnet, so when the tokens and an equity price feed land on Arc it's a token address, a feed and a route. Happy to go deeper on any piece.

## Intro to admins (short)

Hi all, I'm [name], building **Reins** on Arc.

The pitch: give an AI a budget it physically cannot run off with. You put USDC in your own contract and tell it the rules in plain English. "Only SPYx and NVDAx. Never more than $200 a trade. Stop if I lose 10%." Those become on-chain constraints. A trade that breaks one just reverts, and the agent gets told which rule it broke and why. There is no function that lets it withdraw. You can leave whenever, even mid-position, without asking anyone.

What's live on Arc testnet today: the contracts, a Uniswap v4 route checked against Chainlink on every fill, an MCP server so Claude or any bot can drive an agent, and the app at https://app.reins.one. In the live run an agent bought euros, then got refused for size, for an asset it wasn't granted, for a price the pool couldn't fairly give, and for the wrong key. A stranger froze it when it fell through its floor. All of it is on-chain, including the refusals.

Where it's going: tokenized stocks on Arc. A leaderboard of strategies anyone can run or follow, with track records read straight from the chain, so nobody can fake a return and nobody can touch your money. Your rules bind on top of theirs. Revoke the key and it stops next block. The app already runs against a simulated equity, so the day the real tokens and feeds land, it's a config change.

https://reins.one · https://x.com/onreins

## Intro to admins (under 1000 characters)

Hi all, I'm Yip, building Reins on Arc: give an AI a budget it physically cannot run off with.

You put USDC in your own contract and set the rules: per-trade cap, loss limit, oracle price band, allowed assets. A trade that breaks one reverts, and the agent is told which rule and why. It has no withdraw function. You can exit any time, mid-position, asking nobody.

Live on Arc testnet: contracts, Uniswap v4 routing checked against Chainlink on every fill, an MCP server so Claude or any bot can drive an agent, and the app. In the live run an agent bought EURC, then got refused for size, for an asset it wasn't granted, for an unfair price, and for the wrong key. A stranger froze it at its floor. All on-chain, refusals included.

Next: tokenized stocks on Arc. Strategies anyone can run or follow, track records read from chain, your rules binding on top. Already built against a simulated equity.

reins.one · app.reins.one · github.com/onreins · x.com/onreins
