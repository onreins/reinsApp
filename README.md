# Verdict

**A neutral evaluator for agent work on [Arc](https://arc.io).**

ERC-8183 lets one agent hire another and hold the payment in escrow. Someone
has to decide whether the work was any good — the standard calls that role the
**evaluator**, and it lets the client name anyone to it.

Circle's own quickstart names the *client*. The buyer judges their own
purchase. They can reject good work and take the escrow back, and no provider
should accept those terms once real money is involved.

That seat needs an occupant with nothing to gain from the answer. This is one.

```
  1. honest provider                      2. buggy provider
  ─────────────────────                   ─────────────────────
  verdict: PASSED (3/3)                   verdict: FAILED (1/3)
    pass  adds two numbers                  FAIL  adds two numbers
    pass  handles zero                            expected "5", got "6"
    pass  handles negatives                 pass  handles zero
                                            FAIL  handles negatives
  status    Completed                             expected "-2", got "-8"
  provider  +$10.00
  client    unchanged                      status    Rejected
                                           provider  unchanged
                                           client    +$10.00

  3. provider swaps the code after committing
  ───────────────────────────────────────────
  verdict: ABSTAIN
    deliverable hashes to 0x1e3be931…, but the provider committed to 0x9f5a4eeb…

  status    Submitted        escrow untouched — the evaluator refused to
  provider  unchanged        take a side. The job expires and the client
  client    unchanged        reclaims it without anyone judging.
```

*`npm run demo:verdict` reproduces this.*

---

## How it decides

1. **The client publishes a spec** — the tests the work must pass — and names
   it in the job description by URI and hash.
2. **The provider publishes a deliverable** and commits its hash on-chain via
   `submit()`.
3. **The evaluator fetches both**, checks each against its committed hash,
   re-runs the tests in a sandbox, and calls `complete()` or `reject()`.
4. **The verdict is published in full** — every test, its output, the reason it
   passed or failed — and signed. Either party can re-run it and compare.

Everything is content-addressed. That is the load-bearing property: a hash
committed on-chain *before* evaluation means neither side can swap the content
afterwards and argue about what was really submitted.

## Abstaining

There are three outcomes, not two:

| | |
|---|---|
| `passed` | every test passed → escrow released |
| `failed` | the work is real but wrong → escrow refused |
| `abstain` | **we could not judge honestly → nothing happens** |

If the deliverable won't fetch, or doesn't hash to what was committed, or the
spec is malformed, the evaluator declines to act. It does not guess, and it
does not default to whichever side is asking. The escrow is left alone and the
job's own expiry returns the money to the client with no one having taken a
view.

An evaluator that guesses under uncertainty is worse than no evaluator, because
both parties relied on it. Scenario 3 above is this working: the provider
committed to good code, then served bad code from the same URL. The evaluator
noticed, and refused to move anyone's money.

## What it plugs into

| | |
|---|---|
| **ERC-8183** | Holds the `evaluator` seat. `complete()` / `reject()` against the verdict hash. |
| **ERC-8004** | Answers `validationRequest()` with a 0–100 `validationResponse()`. |

Addresses are configuration, so the same code runs against the local mocks,
Arc testnet, and mainnet.

## Status, honestly

**The market this serves does not exist yet.** Measured on 2026-09-24:

- ERC-8004's registries are on Arc **testnet only** — the documented addresses
  have no code on mainnet. No real money has ever moved through an agent job.
- 51,664 agent identities are registered, but that is an **airdrop campaign**,
  not agents. There's a live points program and quest campaign ahead of an
  unconfirmed ARC token.
- Validation traffic tells the story: ~300 addresses, almost exactly **one
  transaction each**, over three days in September, then nothing. Real
  validators validate repeatedly. One-and-done per address is a quest step.

So this is built ahead of demand, deliberately. Arc's mainnet is days old and
Circle is pushing the agent stack hard, with Visa, BlackRock and Mastercard as
founding validators. Being early is a choice, not an accident — but nobody
should read the 51k number as a market.

## Quickstart

```bash
npm install
npm run build
```

```bash
npm run chain          # local node
```

```bash
npm run demo:verdict   # the evaluator, four scenarios
npm run demo:service   # the metered sandbox it runs on
npm test               # 87 tests
```

## Using it

```js
import { Evaluator } from "ratchet/evaluator";

const evaluator = new Evaluator({
  publicClient, wallet,
  jobs: AGENTIC_COMMERCE_ADDRESS,
  validation: VALIDATION_REGISTRY_ADDRESS,
  publish: store.publisher(),   // where verdicts go
});

await evaluator.scan({ fromBlock });   // find work addressed to us, judge it
```

Writing a spec:

```js
import { jobSpec, encodeJobDescription } from "ratchet/evaluator";

const spec = jobSpec({
  language: "python",
  timeoutMs: 10_000,
  tests: [
    { name: "adds two numbers", stdin: "2 3", expect: { stdout: "5" } },
    { name: "handles negatives", stdin: "-4 2", expect: { stdout: "-2" } },
  ],
});

const { uri, hash } = store.put(spec);
const description = encodeJobDescription({ uri, hash, summary: "sum two integers" });
// -> pass as `description` to createJob()
```

## The sandbox underneath

Re-execution is the verification method — EIP-8004's own first suggestion — so
the evaluator is built on a metered code sandbox that also stands alone as a
service: agents pay per millisecond in USDC, with no account and no card.

```
  106 runs · 4 on-chain transactions · $0.0003/run · collection costs 0.93% of revenue
```

That works because of **Ratchet**, a payment channel underneath: the agent
locks USDC once, signs a cumulative voucher per call instead of transacting,
and the provider redeems only the newest. Thousands of calls settle in two
transactions. See `src/server.js` for the metering and the subtlety about never
redeeming a voucher worth more than was actually used.

## Security

**Payment.** The vault has no owner, no admin function, no upgrade path and no
pause. EIP-712 binds every voucher to one chain and one vault; channel ids come
from a counter that never resets; signature malleability is rejected.

**The sandbox.** Under Docker: no network at all, capped memory and pids,
read-only root, dropped capabilities, non-root user, output caps, stripped
environment. **The `process` backend is not a security boundary** — it's a bare
child process with a timeout, fine for development, and it will let submitted
code read your filesystem. The service warns on startup when Docker is absent.

**87 tests**, mostly adversarial: forged and malleated signatures, stale-voucher
replay, cross-channel and cross-vault replay, overdrafts, early sweeps,
concurrent calls racing one ledger, content swapped after commitment, specs
that assert nothing, handlers charging past their ceiling, and a restarted
evaluator trying to settle a job twice.

## What this is not

- **Not audited.** 87 tests are not an audit.
- **The ledger is in memory.** A crash loses unsettled vouchers — not on-chain
  funds, but the un-redeemed tail. Back `MemoryLedger` with Postgres before
  production. Biggest gap between this and a real deployment.
- **Only verifiable work.** Re-execution judges code, computation, data
  transforms. It cannot tell you whether marketing copy is good. Start where
  the answer is checkable.
- **The evaluator is trusted, not trustless.** Verdicts are signed, published
  in full, and reproducible, so cheating is *detectable* — but nothing stakes
  or slashes it yet. EIP-8004 explicitly leaves incentives out of scope.
- **Mocks, not the real contracts.** `contracts/Mocks.sol` implements the
  published ERC-8183 and ERC-8004 interfaces so the thing can be tested. The
  real registries are addressed by configuration; the mocks never ship.

## Arc notes

- **Native USDC is 18 decimals; the ERC-20 view of the same balance is 6.** One
  balance, not two. ERC-8183 moves the ERC-20 form; the payment channel uses
  native. Rounding to 6dp first would truncate sub-cent prices.
- **Block timestamps are only non-decreasing, never strictly increasing.** Every
  deadline in the vault is a block number for that reason. Job deadlines come
  from the chain's clock, never the local one.
- **The base fee floor is 20 gwei**, paid to the block producer, not burned.
  Transactions below it are dropped silently, with no receipt.
- **`PREVRANDAO` is always 0.** No on-chain randomness.
- **Arc's public RPC refuses wide `eth_getLogs` ranges.** `scan()` takes a block
  window; use an indexing provider for anything broad.
- The docs list the testnet RPC under `arc.io`; viem ships `arc.network`. Both
  answer, both report chain id 5042002.

| | mainnet | testnet |
|---|---|---|
| chain id | 5042 | 5042002 |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| ERC-8004 | **not deployed** | `0x8004A8…` / `0x8004B6…` / `0x8004Cb…` |
| faucet | — | [faucet.circle.com](https://faucet.circle.com) |

## Layout

```
evaluator/          the product
  spec.js           the Verdict protocol — specs, deliverables, canonical hashing
  verify.js         resolve, check commitments, run, decide (incl. abstain)
  index.js          holds the seat: ERC-8183 and ERC-8004 actions
  abi.js            published interfaces + known registry addresses
  store.js          content-addressed document store

service/            the metered sandbox, also sellable on its own
src/                sandbox, payment channel, metering, client
contracts/          RatchetVault.sol + Mocks.sol (test scaffolding)
test/               87 tests
demo/               verdict.js, service.js, run.js
```

## License

MIT
