# Mandate: how it works

*A plain-language walkthrough. Last updated 2026-09-25.*

## The problem in one paragraph

People are starting to let AI agents handle money. Nobody sane gives an agent a
wallet: a bad prompt, a bug or a jailbreak and the money is gone, and you find
out afterwards. The usual answer is "watch it closely", which doesn't scale and
doesn't work while you're asleep.

## The idea

Don't trust the agent. Put the money in a **Mandate**: a smart contract that
holds the dollars and enforces your rules on every single trade. The agent gets
a key that can do exactly one thing, "trade within these rules", and nothing
else. The rules aren't a policy document or a prompt; they're code that runs
before any money moves.

Think of it as a company card with a spending limit, except the limit is
enforced by the card itself rather than by a person reading statements later.

## The five rules

Set once, at creation, and never changeable afterwards:

| Rule | What it stops |
|---|---|
| **Allowed assets only** | The agent buying something you never approved |
| **Max trade size** | One bad decision costing everything |
| **Fair price** | The classic attack: trading at a terrible price into a pool the attacker controls. Every fill is compared with Chainlink's price and refused if it's worse than your slippage limit |
| **Loss limit** | Death by a thousand cuts. A trade that would push losses past your limit simply reverts |
| **Expiry** | A forgotten agent trading forever |

Plus the one that isn't a rule so much as a shape: **the agent has no function
that sends money anywhere**. There is no "withdraw" it can call. The only
address funds can leave to is yours.

## What happens when a trade is attempted

```
agent: "trade $10 of USDC for EURC"
   │
   ├─ is this key the agent?                      no → refuse
   ├─ frozen, or expired?                         yes → refuse
   ├─ are both assets on the allowed list?        no → refuse
   ├─ is $10 within the trade size limit?         no → refuse
   ├─ ask Chainlink: what is EURC worth?
   │     price older than the age limit?          yes → refuse
   ├─ work out the fair amount, minus slippage
   ├─ do the swap on Uniswap
   ├─ measure what actually arrived (don't trust the exchange)
   ├─ less than the floor?                        yes → revert the whole thing
   ├─ would this push losses past the limit?      yes → revert the whole thing
   └─ done, and the trade is logged on-chain
```

Every "refuse" is a revert: the transaction never happened, and nothing moved.

## The public stop-loss

The loss limit above only triggers on a trade. But markets move on their own: an
agent could be holding euros when the euro falls, with no trade to check.

So `checkpoint()` is callable **by anyone**. If a mandate's value has fallen
past its floor, any passer-by can freeze it, and the agent is stopped until the
owner decides what to do. You don't have to be watching, and neither do we.

## What the owner can always do

- **Withdraw anything, any time.** Even mid-strategy.
- **Swap the agent** for a different one, or **revoke it** entirely, which takes
  effect on the next block.
- **Withdraw everything and revoke, in one call.**

A subtlety worth stating, because a security review caught it: the owner's exit
must never depend on a price feed being healthy. If an oracle goes stale or
breaks, withdrawals still work (a broken asset is simply valued at zero for the
bookkeeping), and `removeAsset` hands that asset back and drops it from the
mandate. The agent, meanwhile, still can't trade on a stale price.

## How an AI agent actually uses it

Two ways, same rules underneath.

**1. Over MCP** (Claude, or any agent framework that speaks it):

```bash
MANDATE_ADDRESS=0x… MANDATE_AGENT_KEY=0x… npm run mandate:mcp
```

The agent gets three tools:

- `mandate_status` — how much money, what it holds, the rules, and how much
  room is left before the loss limit
- `mandate_price` — the oracle price its trades will be judged against
- `mandate_trade` — trade one asset for another

When a trade breaks a rule, the agent doesn't get a stack trace. It gets:

```json
{ "ok": false, "rule": "TradeTooLarge",
  "reason": "the trade is larger than the mandate's per-trade limit" }
```

so it can correct itself and try something smaller.

**2. In JavaScript**, via `mandate/sdk.js`, which is what the reference agent
in `agents/fx-reversion.js` uses.

## The reference agent

Deliberately simple, so anyone can check it. Chainlink says what a euro is
worth; the Uniswap pool drifts around that as people trade. When euros are
cheap in the pool by more than the trading fee plus a margin, buy; when they're
expensive, sell; otherwise hold. Every decision is logged with its reason:

```json
{"at":"2026-09-25T…","action":"hold",
 "reason":"pool is +3.0 bps from Chainlink; need ±20 to act"}
```

## Proof it works, without spending anything

```bash
npm run sim:mainnet -- 10
```

This is the trick I'm proudest of. It's a single read-only call against **live
Arc mainnet**, with a temporary state override that exists only inside that
call. Inside it, a real Mandate and a real Uniswap adapter are deployed, funded
with pretend dollars, and an agent trades $10 into euros and back through the
**real** pool, checked against the **real** Chainlink feed. Nothing is
broadcast; no keys, no money, no risk.

```
  Chainlink EURC/USD   $1.1379
  bought               8.7808 EURC for $10.00  (0.081% from the oracle price)
  equity at the end    $19.9900  (round trip cost $0.0100)
```

A $400 trade fills at the same price, so the pool is deep enough for real
agents.

## Where it runs

Arc is Circle's new blockchain, where the money *is* dollars (USDC) and fees are
about a cent. Today exactly one pool there has real depth: **dollars against
euros**. So version one is a currency agent. ETH and BTC need no new code, just
a pool with liquidity in it.

## What's been checked

- **216 automated tests**, most of them adversarial: an agent trying to
  overtrade, to touch assets it shouldn't, to drain value through a colluding
  exchange, to keep trading past the loss limit or the expiry, plus hostile
  exchanges that steal the input or call back in mid-trade.
- **An independent security review** of the contract. Nothing critical. It found
  a broken feed could block partial withdrawals, a mid-swap stop-loss could
  freeze a healthy mandate, and rounding could loosen limits on dust trades. All
  three are fixed, each with a test that reproduces the original attack.

## What it costs

| | |
|---|---|
| Deploying the factory and exchange adapter | ~$0.10, one time |
| Creating a mandate | a few cents |
| A trade | ~$0.002 of gas, plus the pool's 0.05% fee |

## Not done yet

- **Not deployed to mainnet.** Blocked on funding a fresh deployer key.
- **The arena** (a public leaderboard of agents and their decisions) is designed
  but not built.
- **No LLM agent yet.** The reference agent follows fixed rules. Wiring Claude
  to the MCP server needs an API key.
- **Not formally audited.** One adversarial review and 216 tests is not an audit.
