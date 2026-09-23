# Ratchet

**Pay-per-call API metering on [Arc](https://arc.io), settled in USDC.**

An API charges $0.001 a call. An agent makes a thousand calls. That is $1.00 of
revenue — and on most chains, far more than $1.00 of gas to collect it.

Ratchet collects it for **$0.0003**.

```
  1000 paid API calls
     4 on-chain transactions
   250 calls per transaction

  every transaction this took:
    open channel       138002 gas   $0.0001381
    settle voucher      68410 gas   $0.00006845
    settle voucher      51314 gas   $0.00005134
    claimAndClose       63732 gas   $0.00006376

  revenue to provider      $1
  total on-chain cost      $0.00032166
  overhead                 0.032% of revenue
  cost per call            $0.0000003216

  one on-chain tx per call would cost  $0.068453
  ratchet costs                        $0.00032166
  cheaper by                           212x
```

*(Measured, not estimated — `npm run demo` reproduces it. Gas figures are real;
prices use Arc's 20 gwei base-fee floor, which is what testnet actually charges.)*

---

## The idea

A **unidirectional payment channel**, specialised for metered API usage.

1. The payer locks USDC in a vault, once.
2. Every call, they sign an off-chain voucher: *"you may take up to $X total from
   this channel."* Signing is local — no transaction, no block, no wait.
3. Each voucher's total is higher than the last. It only ever ratchets forward.
4. The provider keeps **only the newest voucher** and throws the rest away.
   Redeeming that one settles the entire history in a single transaction.

The provider is never exposed: they hold a signature worth everything they are
owed and can cash it whenever they like. The payer is never exposed: the vault
can only ever pay out what they signed for, and never more than they deposited.

Lost vouchers cost nothing. Out-of-order vouchers cost nothing. Only the maximum
matters.

## Why this needs Arc specifically

This design is decades old and has never worked well for paid APIs. Three things
about Arc change that:

**Gas is USDC.** The payer needs one asset, not two. No agent has to hold a
volatile gas token, watch its balance, or fail a call because it ran dry. A
budget is denominated in the same unit as the bill.

**Fees are stable and dollar-denominated.** At Arc's 20 gwei floor, a settlement
costs a reliable $0.0012 — so the break-even point is *knowable in advance*. You
can say "settle every $0.40" and reason about the economics. On a chain with a
volatile gas token, the overhead ratio moves under you, and sub-cent pricing is
a gamble on the fee market.

**Sub-second deterministic finality, no reorgs.** Opening a channel is a
half-second pause, not a "wait for confirmations" dance. A settled voucher is
settled — the provider doesn't need a reorg policy.

Take any one of these away and the product gets meaningfully worse.

## Quickstart

```bash
npm install
npm run build          # compile the contract
```

Two terminals:

```bash
npm run chain          # local node
```

```bash
npm run demo           # 1000 paid calls, end to end
npm test               # 38 tests
```

### Against Arc testnet

```bash
npm run keygen -- 2                     # a payer and a provider key
# fund both addresses at https://faucet.circle.com (network: Arc testnet)

RATCHET_DEPLOYER_KEY=0x... npm run deploy
```

```bash
RATCHET_RPC=https://rpc.testnet.arc.io \
RATCHET_VAULT=0x...        \
RATCHET_PAYER_KEY=0x...    \
RATCHET_PROVIDER_KEY=0x... \
npm run demo
```

## Using it

### Charging for an API

The only Ratchet-aware line is the middleware. Your routes never learn they are
being billed.

```js
import express from "express";
import { meter } from "ratchet/server";
import { arcTestnet } from "viem/chains";

const app = express();

app.use("/v1", meter({
  price: "0.001",           // USDC per call
  provider: PROVIDER_ADDRESS,
  vault: VAULT_ADDRESS,
  chain: arcTestnet,
  publicClient,
  wallet: providerWallet,   // omit to disable auto-settlement
  settleAt: "0.40",         // redeem once this much has accrued
}));

app.post("/v1/sentiment", (req, res) => {
  res.json({ score: analyse(req.body.text) });
  // req.ratchet => { payer, charged, cumulative, remaining, calls }
});
```

Per-request pricing, for endpoints that aren't flat-rate:

```js
meter({ ...opts, priceFor: (req) => req.body.tokens > 1000 ? "0.005" : "0.001" })
```

### Paying for one

```js
import { RatchetClient } from "ratchet/client";

const agent = new RatchetClient({
  wallet, publicClient, chain: arcTestnet,
  budget: "5.00",   // hard cap; throws rather than exceed it
});

const res = await agent.fetch("https://api.example.com/v1/sentiment", {
  method: "POST",
  body: JSON.stringify({ text: "..." }),
});
```

That is the entire integration. The first call to a host costs a 402 round-trip
while the client learns the terms and opens a channel; every call after that
pays up front from cache. `agent.summary()` reports what has been spent.

## How settlement works

```
  payer                          provider                        vault
    │                                │                             │
    │  open(provider, challenge)     │                             │
    ├────────────────────────────────┼────────────────────────────►│  ← tx 1
    │                                │                             │
    │  GET /v1/thing                 │                             │
    ├───────────────────────────────►│                             │
    │         402 + terms            │                             │
    │◄───────────────────────────────┤                             │
    │                                │                             │
    │  sign voucher($0.001)          │                             │
    │  GET /v1/thing + voucher       │                             │
    ├───────────────────────────────►│  verify sig, book revenue   │
    │         200 OK                 │                             │
    │◄───────────────────────────────┤                             │
    │                                │                             │
    │   … 999 more, all off-chain, ~300/sec …                      │
    │                                │                             │
    │                                │  claim(latest voucher)      │
    │                                ├────────────────────────────►│  ← tx 2
    │                                │                             │
    │                                │  claimAndClose(final)       │
    │                                ├────────────────────────────►│  ← tx 3
    │◄─ ─ ─ ─ ─ ─  refund of unspent deposit ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
```

## Security model

The contract is 6.4 KB and has no owner, no admin function, no upgrade path and
no pause. It holds deposits and pays them out against signatures. That is all.

**What the provider can do.** Redeem any voucher the payer signed, at any time,
in any order. They cannot invent one: `ecrecover` must return the channel's
payer. They cannot exceed the deposit. They cannot replay a spent voucher —
`claimed` only moves up.

**What the payer can do.** Stop signing, and eventually reclaim the remainder.
They cannot reclaim instantly: `initiateClose` starts a challenge window (floor:
~1 hour, default: 1 day) during which the provider can still redeem everything
outstanding. They cannot double-spend a deposit across two providers — a channel
names exactly one.

**Replay.** The EIP-712 domain binds every voucher to one chain id and one vault
address. Channel ids come from a counter that never resets, so a voucher from a
closed channel can never be replayed against a later one. Signature malleability
is rejected — `s` must be in the lower half of the curve order.

**Griefing.** Payouts forward a 100k gas stipend and fall back to a
`withdrawable` credit if delivery fails, so a contract that reverts on receive
cannot block its counterparty's settlement. `claim` and `sweep` are callable by
anyone and always pay the channel's own parties, so a relayer can settle on
either side's behalf.

Tested adversarially — forged signatures, stale vouchers, cross-channel and
cross-vault replay, malleated signatures, overdrafts, early sweeps, and 25
concurrent calls racing one channel's ledger.

### What is *not* covered

- **No audit.** 38 tests are not an audit. Do not put real money on this yet.
- **The ledger is in memory.** Restart the provider and you lose unsettled
  vouchers — not funds already on-chain, but the un-redeemed tail. `MemoryLedger`
  is a four-method interface; back it with Redis or Postgres before production.
  This is the single biggest gap between this and a real deployment.
- **Trust within a call.** The payer signs before the response arrives, so a
  provider can take payment and return garbage. Payment channels don't solve
  this; reputation, refunds via signed credits, or escrowed verification do.
- **One channel per provider.** Paying fifty APIs means fifty deposits. A shared
  vault with per-provider sub-balances would fix this and is the obvious v2.
- **Local tests can't model Arc exactly.** Hardhat reproduces the contract logic,
  not Arc's USDC-as-gas accounting or EIP-7708 transfer logs. Testnet is the real
  check.

## Arc notes worth knowing

Things that bit me, or would have:

- **Native USDC is 18 decimals; the ERC-20 view of the same balance is 6.** They
  are one balance, not two. Ratchet records everything in 18dp — rounding to 6dp
  first would silently truncate sub-cent prices, which is exactly the range we
  bill in. Divide by 1e12 only to display.
- **Block timestamps are only non-decreasing, never strictly increasing.** Every
  deadline in the contract is a block number for this reason. At ~0.5s a block,
  a day is 172,800.
- **The base fee floor is 20 gwei and it is paid to the block producer, not
  burned.** Transactions below the floor are dropped silently, with no receipt.
- **`PREVRANDAO` is always 0.** No on-chain randomness; use an oracle.
- **Value transfers to the zero address revert.** Burning is forbidden, so
  "send it nowhere" is not an escape hatch.
- The docs list the testnet RPC under `arc.io`; viem ships `arc.network`. Both
  answer and report chain id 5042002.

| | mainnet | testnet |
|---|---|---|
| chain id | 5042 | 5042002 |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| explorer | [explorer.arc.io](https://explorer.arc.io) | [explorer.testnet.arc.io](https://explorer.testnet.arc.io) |
| faucet | — | [faucet.circle.com](https://faucet.circle.com) |

## Layout

```
contracts/RatchetVault.sol   the whole protocol, 6.4 KB
src/voucher.js               EIP-712 signing, verification, wire format
src/server.js                provider middleware + settlement policy
src/client.js                agent-side fetch wrapper
src/vault.js                 contract calls
src/usdc.js                  18dp/6dp handling
demo/                        a paid API and an agent that hammers it
test/                        38 tests, mostly about cheating
scripts/                     compile, deploy, keygen
```

## License

MIT
