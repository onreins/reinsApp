# Circle Developer Grant — application draft

> **Status: draft, not submitted.** Submission is the founder's decision. Fields
> follow the criteria Circle publishes for the relaunched, Arc-forward program
> (circle.com/grant): Arc and Circle alignment, technical readiness, traction or a
> credible path to it, and ecosystem impact. Funding is milestone-based, $5k–$100k
> in USDC. Figures in brackets are for the founder to confirm.

---

## One line

Verdict is the neutral evaluator for agent work on Arc: it decides whether an
ERC-8183 job's escrowed USDC is released or refunded by re-running the delivered
work against tests both parties agreed to up front.

## Focus area

**Agentic economic activity** — specifically the *outcome marketplaces* named in
Arc's Request for Builders. Paying for outcomes requires someone to verify outcomes.

## The problem

ERC-8183 gives agent-to-agent commerce a clean escrow primitive: a client funds a
job, a provider delivers, and a designated **evaluator** calls `complete()` or
`reject()`. The standard lets the client name anyone to that seat — including
themselves — and the quickstart does exactly that. A buyer who evaluates their own
purchase can reject good work and reclaim the escrow, so no provider can safely
accept those terms once real money is involved.

The official ERC-8183 reference implementation ships an evaluator *stub* and calls
evaluator design "the hardest part". Existing evaluators elsewhere either ask an LLM
(non-deterministic, not reproducible) or compare hashes of an answer the client
already knew (which cannot express "build me something that does X"). None runs on
Arc. We measured Arc's ERC-8004 ValidationRegistry directly: 251 validation
responses from 251 distinct addresses, none of which answered twice — no validator
service exists there today.

## What we built

- **Verdict evaluator.** The client commits a test spec by hash in the job; the
  provider commits a deliverable by hash on `submit()`. Verdict fetches both, checks
  them against the on-chain hashes, re-runs the tests in a sandbox, and settles.
  Three outcomes: `passed`, `failed`, and `abstain` — if it cannot verify honestly
  (content swapped after commitment, unfetchable, malformed), it refuses to move
  anyone's money.
- **`AgenticCommerce`** — an ERC-8183 escrow for Arc, since none existed. No owner,
  no admin keys, no upgrade path, fee immutable and capped at 2.5%. `selfEvaluated()`
  exposes the self-evaluation trap in one call.
- **Reproducibility.** Job inputs are stored on-chain as content-addressed `data:`
  URIs. `npm run verify -- <jobId>` re-derives any verdict from chain data alone, with
  no keys and no trust in us.
- **Compute sold per run through Circle Gateway Nanopayments.** Our sandbox speaks
  x402 and settles in batched, gasless USDC on Arc.

## How Arc and Circle are load-bearing

| Circle / Arc component | How we use it |
|---|---|
| **Arc** | Contracts deployed and jobs settled on Arc testnet; deterministic sub-second finality means a verdict settles as soon as it is reached |
| **USDC** | Every escrow, payout, refund and fee is USDC; gas is USDC |
| **Gateway / Nanopayments (x402)** | The sandbox service charges per run through Circle's facilitator — verified issuing a correct `GatewayWalletBatched` challenge on `eip155:5042002` |
| **ERC-8004 / ERC-8183 (agent stack)** | We implement the ERC-8183 evaluator role and answer ERC-8004 validation requests |

We deliberately settle through Circle's payment layer rather than our own: an early
version used custom payment channels, which we moved off once Nanopayments covered
the same need. Our contribution is verification, the part Circle's stack leaves open.

## Evidence of shipping (traction)

We have no paying users yet, and say so plainly. What exists today:

- **Live on Arc testnet:** `AgenticCommerce` at `0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d`
- **Two real jobs settled end to end** with three distinct keys as client, provider
  and evaluator — one passed and paid, one failed and refunded. Every transaction is
  linked in `docs/live-run/LIVE-RUN.md`, and both pass independent re-verification.
- **136 automated tests**, most of them adversarial.
- **Two adversarial security audits before deployment**, which found and fixed one
  critical, one high, three medium and two low-severity issues — including a payer
  being able to destroy $93 of a provider's earned funds for 1 wei, reproduced on a
  real chain before the fix.
- Public source: [repository URL].

## Milestones

| # | Milestone | Verifiable by | Ask |
|---|---|---|---|
| 1 | **Evaluator service live on Arc testnet** — continuously watching `AgenticCommerce`, judging any job that names it, with a public status page and published verdicts | Anyone posts a job naming our evaluator and watches it settle; `verify-job` passes | [$10k] |
| 2 | **Accountability layer** — evaluator bonds USDC per verdict; a challenge window lets anyone re-run and dispute; a verdict proven wrong is slashed to the wronged party | Contracts + adversarial audit + a demonstrated successful challenge on testnet | [$15k] |
| 3 | **Mainnet launch** with isolated (container) execution, durable state, and 3 external teams posting real jobs | Mainnet addresses; jobs from addresses we do not control | [$15k] |
| 4 | **Integrations** — SDK for agent frameworks to post verified jobs in a few lines, plus an evaluator hook for existing ERC-8183 marketplaces on Arc | Published package; at least one third-party marketplace integration | [$10k] |

**Total ask: [$50k]**, disbursed per milestone.

## Why now, and why us

Arc's mainnet is days old and the agent stack is being built out now. The evaluator
seat is structurally vacant — it cannot be self-served, because a party with a stake
in the outcome cannot be its referee — and the teams building marketplaces need
someone else to hold it. We would rather be there on day one with audited, working,
reproducible infrastructure than arrive once the pattern has set.

## Honest risks

- Agent-to-agent job volume is early everywhere, not only on Arc. Milestone 3 is
  gated on real external usage for that reason.
- Re-execution verifies only checkable work — code, computation, data transforms. It
  does not judge subjective quality. We start where the answer is checkable.
- Until milestone 2 ships, the evaluator is trusted, not trustless: verdicts are
  signed and reproducible, so cheating is detectable but not yet punished.

## Team

[Founder name, background, and links.] Technical ownership: the full stack in this
repository — contracts, evaluator, sandbox, payment integration and test suite.

## Contact

[Email] · [repository URL] · [Arc address for disbursement]
