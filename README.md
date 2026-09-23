# Ratchet

**A code sandbox that AI agents can pay for — per millisecond, in USDC, with no account.**

An agent writes code and needs somewhere to run it. Today that means a human
signs up, enters a credit card, manages an API key, and pays a monthly minimum
whether the agent runs six jobs or six million.

This removes the human. An agent with a wallet and a budget can run code. That
is the entire relationship: no signup, no key, no card, no subscription.

```
  task                   result                          time        cost
  ────────────────────── ────────────────────────── ───────── ───────────
  arithmetic             333283335000                555.53ms     $0.0005
  parse + aggregate      {"apac": 239800, "emea": …  519.64ms     $0.0005
  string work (js)       ["eht","kciuq","nworb","x…  133.82ms     $0.0003
  heavier compute        primes under 2m: 148933     556.23ms     $0.0005
  code that crashes      exit 1: Traceback (most r…  512.74ms     $0.0005
  code that hangs        timed out, killed          1539.08ms      $0.001

  now 100 runs back to back... done in 13.7s ($0.03005, $0.0003/run)

  agent spent            $0.0333 across 106 runs
  average per run        $0.000314
  authorised (ceilings)  $0.0382  ← reserved, not spent
  never charged          $0.0049 of reserved headroom

  on-chain transactions  4
  gas paid by provider   $0.00030902
  cost of collection     0.93% of revenue
```

*Measured, not estimated — `npm run demo:service` reproduces it.*

---

## Why this exists

Selling compute in tenth-of-a-cent units has never worked, for two reasons.

**Collecting the money cost more than the money.** A card charge has a fixed
fee measured in cents; an on-chain transfer costs gas. Either way, billing
$0.0003 per run is absurd — so everyone sells subscriptions instead, and light
users subsidise heavy ones.

**The buyer had to be a person.** Signup, KYC, a card, a billing address. An
autonomous agent has none of these and cannot acquire them.

Both constraints have quietly lifted. Agents now do real work on their own, and
Arc makes moving small amounts of money cheap enough to be worth doing. So the
natural unit of sale changes from *a seat per month* to *a millisecond*.

## How the billing works

A **payment channel**, shaped for metered usage. It's a bar tab:

1. The agent locks USDC in a vault, once.
2. Before each run it signs a voucher: *"you may take up to $X in total."*
   Signing is local — no transaction, no block, no wait.
3. Each voucher's total is higher than the last. It only ratchets forward.
4. We keep **only the newest voucher** and bin the rest. Redeeming that one
   settles the entire history in a single transaction.

Thousands of runs cost two on-chain transactions, not two thousand.

Neither side can cheat. We can't forge a voucher — it needs the agent's
signature. We can't take more than was signed for, or more than the deposit.
The agent can't run out on the tab — the money is already locked, and reclaiming
it starts a challenge window during which we can still redeem what we're owed.

### Charging for work whose cost you don't know in advance

This is the part that makes it fit compute rather than flat-rate API calls.

One run takes 8ms; the next takes 4 seconds. So the voucher authorises a
**ceiling** — the worst case for the timeout you requested — and we charge what
the run actually used. Ask for a 30-second timeout and finish in 50ms, and you
pay for 50ms. The ceiling only reserves headroom.

That creates one subtlety worth stating plainly, because it is where a careless
implementation would quietly overcharge. A voucher says *"you may take up to X"*,
and redeeming one takes **all** of X. Since the newest voucher always authorises
more than has actually been used, redeeming it would overcharge. So settlement
uses the newest voucher whose total is at or **below** genuine usage. It lags
real usage by roughly one run, and is never a penny more than owed.

`test/meter.test.js` asserts this directly: *"never settles a voucher worth more
than was actually used."*

## Pricing

| | |
|---|---|
| Per run | $0.0002 |
| Per second of wall time | $0.0005 |
| Billing increment | 100ms, rounded up |
| Max timeout | 30s |

A typical script costs **$0.0003** — about 3,000 runs per dollar. You are
charged for crashes and timeouts, because the compute was spent either way.
Malformed requests are free.

`GET /pricing` returns this as JSON, along with the payment terms. It needs no
payment.

## Quickstart

```bash
npm install
npm run build
```

Two terminals:

```bash
npm run chain              # local node
```

```bash
npm run demo:service       # the product: an agent runs code and pays
npm run demo               # raw throughput: 1000 calls, 4 transactions
npm test                   # 57 tests
```

### Running it for real

```bash
npm run keygen -- 2                     # a provider and a payer key
# fund both at https://faucet.circle.com (network: Arc testnet)

RATCHET_DEPLOYER_KEY=0x... npm run deploy
RATCHET_PROVIDER_KEY=0x... RATCHET_VAULT=0x... npm run serve
```

### Using it, as an agent

```js
import { RatchetClient } from "ratchet/client";

const agent = new RatchetClient({
  wallet, publicClient, chain: arcTestnet,
  budget: "5.00",          // hard cap; throws rather than exceed it
});

const res = await agent.fetch("https://sandbox.example.com/v1/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ language: "python", code: "print(6*7)", timeoutMs: 5000 }),
});

const { stdout, durationMs, billing } = await res.json();
```

The first call costs a 402 round-trip while the client learns the terms and
opens a channel. Everything after that pays up front from cache.
`agent.summary()` reports actual spend versus authorised ceilings.

## Security

Two separate problems: not getting robbed, and not getting owned.

### Payment

The vault is 6.4 KB with no owner, no admin function, no upgrade path and no
pause. It holds deposits and pays them out against signatures.

EIP-712 binds every voucher to one chain id and one vault address. Channel ids
come from a counter that never resets, so a voucher from a closed channel can
never be replayed against a later one. Signature malleability is rejected. Payouts
forward a gas stipend and fall back to a withdrawable credit, so a contract that
reverts on receive cannot block its counterparty.

Tested adversarially: forged signatures, stale vouchers, cross-channel and
cross-vault replay, malleated signatures, overdrafts, early sweeps, handlers
that try to charge more than their ceiling, and 25 concurrent calls racing one
ledger.

### The sandbox

Under Docker — memory and CPU caps, **no network at all**, read-only root,
dropped capabilities, no-new-privileges, a pid limit against fork bombs, and a
non-root user. Output is capped so a print loop can't exhaust our memory, and
the environment is stripped so our own credentials never reach submitted code.

**The `process` backend is not a security boundary.** It's a bare child process
with a timeout — convenient for development, and it will happily let submitted
code read your filesystem and open sockets. The service prints a warning on
startup if Docker isn't available. Don't accept untrusted callers without it.

## What this is not

- **Not audited.** 57 tests are not an audit. Don't put real money on it yet.
- **The ledger is in memory.** A restart loses unsettled vouchers — not funds
  already on-chain, but the un-redeemed tail. `settleAll()` runs on SIGINT/SIGTERM
  to limit the damage, but a crash still costs you. `MemoryLedger` is a
  four-method interface; back it with Postgres before production. **This is the
  biggest gap between this and a real deployment.**
- **Cold starts dominate.** Python takes ~500ms to start, which is most of the
  bill for a short script. A warm pool of pre-started sandboxes would cut the
  typical cost several-fold, and is the obvious next optimisation.
- **One channel per provider.** Paying fifty services means fifty deposits.
- **Trust within a call.** The agent authorises before seeing the result, so a
  dishonest provider could bill for garbage. Reputation and dispute mechanisms
  are out of scope here.
- **Nobody is buying yet.** The tech works. Whether agents actually show up to
  buy compute this way is the open question, and no amount of code answers it.

## Arc notes

Things that bit me, or would have:

- **Native USDC is 18 decimals; the ERC-20 view of the same balance is 6.** One
  balance, not two. Everything here is recorded in 18dp — rounding to 6dp first
  would truncate sub-cent prices, which is exactly the range we bill in.
- **Block timestamps are only non-decreasing, never strictly increasing.** Every
  deadline in the contract is a block number for that reason. At ~0.5s a block,
  a day is 172,800.
- **The base fee floor is 20 gwei, paid to the block producer rather than burned.**
  Transactions below the floor are dropped silently, with no receipt.
- **`PREVRANDAO` is always 0.** No on-chain randomness; use an oracle.
- **Value transfers to the zero address revert.** Burning is forbidden.
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
service/            the product — sandbox API and its rate card
  index.js          routes, wired to the meter
  pricing.js        what a run costs
  server.js         standalone entry point

src/                the billing engine
  sandbox.js        isolated execution (docker | process)
  server.js         metering middleware, reservations, settlement policy
  client.js         agent-side fetch wrapper
  voucher.js        EIP-712 signing and wire format
  vault.js          contract calls
  usdc.js           18dp/6dp handling

contracts/RatchetVault.sol   the whole protocol, 6.4 KB
test/               57 tests, mostly about cheating
demo/               service.js (the product), run.js (raw throughput)
```

## License

MIT
