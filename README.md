# Verdict

**A neutral evaluator for agent work on [Arc](https://arc.io).**

ERC-8183 lets one agent hire another and hold the payment in escrow. Someone has
to decide whether the work was good enough to release the money — the standard
calls that role the **evaluator**, and lets the client name anyone to it,
including themselves. Circle's own quickstart does exactly that: the buyer marks
their own homework, and can reject good work to take the escrow back.

Verdict holds that seat with nothing to gain from the answer. It re-runs the
delivered code against tests both sides agreed to up front, pays or refuses
accordingly, and **abstains rather than guessing** when it cannot verify.

## Live on Arc testnet

| contract | address |
|---|---|
| `AgenticCommerce` — ERC-8183 job escrow | [`0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d`](https://explorer.testnet.arc.io/address/0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d) |
| `ArbitratedEscrow` — settles on Verdict attestations | [`0xdcfaf4d8be9eedf12fe4b0b4ceafb9d1d580f794`](https://explorer.testnet.arc.io/address/0xdcfaf4d8be9eedf12fe4b0b4ceafb9d1d580f794) |
| `RatchetVault` — USDC payment channels | [`0x2dcf3df463b194844bb7496ea7d32174339fc936`](https://explorer.testnet.arc.io/address/0x2dcf3df463b194844bb7496ea7d32174339fc936) |

Two real jobs have settled on it, with three distinct keys as client, provider
and evaluator:

```
  job #1  correct code   PASSED 3/3   escrow released, provider +$0.10
  job #2  buggy code     FAILED 1/3   rejected, client refunded
          FAIL  adds two numbers — expected stdout "5", got "6"
```

Every transaction is linked in [docs/live-run/LIVE-RUN.md](docs/live-run/LIVE-RUN.md).

### Don't trust us — check it

```bash
npm install && npm run build
npm run verify -- 1
```

`verify` needs no keys. It reads the job from Arc, decodes the spec from the job's
on-chain description and the deliverable from the provider's `submit()` calldata,
checks both against their committed hashes, **re-runs the tests itself**, and
confirms the evaluator's on-chain decision matches. Both live jobs pass every check.

That works because job inputs are stored on-chain as content-addressed `data:`
URIs. No server of ours has to be up for anyone to re-derive a verdict.

## How it decides

1. **The client commits a spec** — the tests the work must pass — by hash, in the
   job description.
2. **The provider commits a deliverable** by hash, in `submit()`.
3. **Verdict fetches both**, checks each against its commitment, re-runs the tests
   in a sandbox, and calls `complete()` or `reject()`.
4. **The verdict is published in full and signed** — every test, its output, why
   it passed or failed. Its hash is the `reason` recorded on-chain.

Three outcomes, not two:

| | |
|---|---|
| `passed` | every test passed → escrow released |
| `failed` | the work is real but wrong → escrow refused |
| `abstain` | **could not verify honestly → nothing happens** |

If the deliverable won't fetch, doesn't hash to what was committed, or the spec
is malformed, Verdict declines to act — it does not guess, and does not default
to whichever side is asking. The escrow is untouched, and the job's own expiry
returns it to the client. An evaluator that guesses under uncertainty is worse
than none, because both parties relied on it.

## For any escrow: the arbiter API

The evaluator above serves jobs on our own ERC-8183 escrow. Escrow protocols that
already hold funds can ask for a ruling directly:

```bash
npm run arbiter          # POST /v1/rulings on :4080, signed by RATCHET_EVALUATOR_KEY
```

```jsonc
// POST /v1/rulings
{
  "terms":    { "uri": "https://…/terms.json", "hash": "0x3e22…" },  // or { "document": {…} }
  "delivery": { "uri": "ipfs://…",             "hash": "0xadda…" },
  "attest":   { "chainId": 5042002, "escrow": "0xYourEscrow", "caseId": "0x…" }
}
```

The response carries the full ruling, a signature over its hash, and, when `attest`
is given, an **EIP-712 attestation** bound to that escrow, that case and those exact
commitments:

```
Ruling(bytes32 caseId, uint8 outcome, uint8 score,
       bytes32 rulingHash, bytes32 termsHash, bytes32 deliveryHash)
```

Your contract verifies it with the `VerdictRuling` library in
`contracts/ArbitratedEscrow.sol`: check the signer is the arbiter you named, check the
hashes equal what the parties committed, then pay (`1`) or refund (`2`). An abstain
(`3`) must move nothing. `ArbitratedEscrow` is a complete reference escrow built that
way, and its tests show it refusing forged signers, attestations made for a different
escrow, rulings about a different delivery, malleable signatures, and abstains.

This runs live on Arc testnet: two cases on `ArbitratedEscrow`, where the arbiter
API ruled, the contract verified the attestation on-chain, and paid the seller for
working code and refunded the buyer for buggy code. Evidence with every transaction
is in [docs/live-run/ARBITER-RUN.md](docs/live-run/ARBITER-RUN.md)
(`npm run live:arbiter` to reproduce).

Set `VERDICT_PAID=1` to charge **$0.01 per ruling over x402** through Circle
Gateway. The price is the same for every outcome, and malformed requests are
rejected before any charge. URLs are fetched through an SSRF guard: public
addresses only, checked again at connect time so DNS rebinding fails, every
redirect re-checked, and bodies capped while streaming.

## Also: compute, paid per run through Circle Gateway

The same sandbox is sold directly to agents over **x402**, settled by **Circle
Gateway Nanopayments** — batched, and gasless for the payer. No account, no API
key, no card. Run for real on Arc testnet:

```
  python     -> 499999500000   paid $0.0017   (ran 454ms)
  javascript -> 1,2,3          paid $0.0012   (ran 115ms)
  python     -> {"ok": true}   paid $0.0012   (ran 366ms)

  agent gas per call   $0 — Circle batches the authorizations
```

## Running it

```bash
npm install && npm run build
```

Locally, against a throwaway chain:

```bash
npm run chain          # terminal 1
npm test               # terminal 2 — 192 tests
npm run demo:verdict   # the evaluator: pass, fail, and a caught content swap
```

On Arc testnet (needs USDC from [faucet.circle.com](https://faucet.circle.com)):

```bash
npm run keygen                                  # a deployer key; fund its address
echo "RATCHET_DEPLOYER_KEY=0x..." > .env        # .env is gitignored

node --env-file=.env scripts/deploy-arc.js      # AgenticCommerce (+ --with-vault)
npm run setup:roles                             # provider + evaluator keys and gas
npm run live:arc                                # two real verified jobs
npm run pay:x402                                # an agent buys compute via Gateway
npm run evaluator                               # Verdict as a service, watching Arc
```

The evaluator service polls for jobs naming its key, judges them, and settles.
It saves the last handled block atomically and only after a full pass succeeds,
so a crash re-scans rather than skips, and it re-reads each job's status before
acting, so a restart cannot settle anything twice.

## Security

**Contracts.** No owner, no admin function, no upgrade path, no pause. The
protocol fee is immutable and capped at 2.5% at construction — an agent cannot
safely commit funds to a contract whose rake can change. `selfEvaluated(jobId)`
tells a provider in one call whether the client has named themselves evaluator.

**Adversarial reviews ran before each deployment.** Found and fixed:

| severity | finding |
|---|---|
| critical | the arbiter's URL guard could be bypassed by writing a private or cloud-metadata IPv4 in IPv6 notation (`[::ffff:169.254.169.254]` is normalised to hex groups); addresses are now classified by numeric value across mapped, compatible, NAT64, 6to4 and Teredo forms |
| high | a burst of paid requests could exceed the sandbox concurrency limit while payments were being verified; slots are now reserved before any async step |
| high | free-tier callers could fill the disk with distinct rulings; storage is bounded and requests are rate-limited per client |
| medium | a paid request that hit an internal error got a bare 500 after being charged; it now gets a signed abstain |
| critical | a payer could close a payment channel and destroy the provider's unsettled vouchers — $93 of delivered work for 1 wei, reproduced on-chain before the fix |
| high | a USDC-blocklisted recipient made settlement revert forever, letting the client reclaim escrow for delivered work; payouts now fall back to a pull credit |
| medium | an incomplete reentrancy guard let a hook complete a job from inside `reject()` |
| medium | a submission at the deadline could be refunded in the next block; evaluators now get a guaranteed window |
| medium | the metering service could keep serving a channel already counting down to close |
| low ×2 | an unbounded challenge window could brick a channel; a stale quote survived a provider change |

The fixes are checkable on the live contracts (`EVALUATION_WINDOW`,
`MAX_CHALLENGE_BLOCKS`). **192 tests**, most of them adversarial.

**The sandbox.** Under Docker: no network, capped memory and pids, read-only
root, dropped capabilities, non-root user. **The `process` backend is not a
security boundary** — it is for development, and the service warns when Docker
is unavailable.

## Honest limits

- **Not formally audited.** Two adversarial reviews and 192 tests are not an audit.
- **The market is early.** Agent-to-agent job volume is thin everywhere today, not
  only on Arc. Pay-per-call x402 is where live traffic is.
- **Only checkable work.** Re-execution judges code, computation and data transforms,
  not subjective quality.
- **Trusted, not trustless — yet.** Verdicts are signed and reproducible, so cheating
  is detectable, but nothing stakes or slashes. That is the next milestone.

## Arc notes

Things that bit, or would have:

- **Native USDC is 18 decimals; the ERC-20 view of the same balance is 6.** One
  balance, not two. Escrow moves the ERC-20 form; gas and payment channels use native.
- **Block timestamps are only non-decreasing.** Deadlines that need guaranteed
  progress use block numbers.
- **The public RPC refuses `eth_getLogs` ranges of 10,000+ blocks** (~83 minutes), and
  rejects multi-event topic filters. Every log query here pages and filters locally.
- **viem caches `getBlockNumber` for ~4s.** At 0.5s blocks that hides ~8 blocks — enough
  to miss a submission made moments ago. Head is read uncached.
- **Base fee floor is 20 gwei**, paid to the block producer; transactions below it
  are dropped silently.

| | mainnet | testnet |
|---|---|---|
| chain id | 5042 | 5042002 |
| USDC | `0x3600…0000` | `0x3600…0000` |
| ERC-8004 registries | not deployed | `0x8004A8…` / `0x8004B6…` / `0x8004Cb…` |

## Layout

```
contracts/
  AgenticCommerce.sol   ERC-8183 job escrow (deployed)
  ArbitratedEscrow.sol  VerdictRuling verifier library + a reference escrow that settles on it
  RatchetVault.sol      USDC payment channels (deployed)
  Mocks.sol             test scaffolding: USDC with blocklist, ERC-8004 registry, hostile hook

arbiter/                the arbiter API: rulings for any escrow, EIP-712 attestations, SSRF-safe fetch
evaluator/              the product
  spec.js               the Verdict protocol — specs, deliverables, canonical hashing
  verify.js             resolve, check commitments, run, decide (incl. abstain)
  index.js              holds the seat: ERC-8183 and ERC-8004 actions, paged log reads
  daemon.js             the evaluator as a resumable service

service/                sandbox compute sold over x402, settled by Circle Gateway
src/                    sandbox, payment channel, metering, client
scripts/                deploy, verify-job, setup-roles, keygen
demo/                   live-arc, pay-x402, verdict, service
docs/                   live-run evidence, grant draft, handoff
test/                   192 tests
```

## License

MIT
