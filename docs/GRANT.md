# Circle Developer Grant — application draft

> **Status: draft, not submitted.** Submission is the founder's decision. Fields
> follow the criteria Circle publishes for the Arc-forward program
> (circle.com/grant): Arc and Circle alignment, technical readiness, traction or a
> credible path to it, and ecosystem impact. Funding is milestone-based, $5k–$100k
> in USDC. Figures in brackets are for the founder to confirm.

---

## One line

Verdict is a neutral referee for payments between AI agents on Arc: when one agent
pays another from escrow, Verdict re-runs the delivered work against tests both
agreed to, and signs a ruling the escrow contract enforces. It never holds funds.

## Focus area

**Agentic economic activity**, specifically the *outcome marketplaces* in Arc's
Request for Builders. Paying for outcomes requires someone neutral to decide
whether the outcome happened.

## The problem

Agents can already pay each other in USDC. What they can't do is trust each other:

- **Pay up front** (x402 style) and a bad seller keeps the money for broken work.
- **Escrow with the buyer as judge**, which is what ERC-8183 allows and its
  quickstart does, and a bad buyer can reject good work and take the money back.

Escrow protocols for agents exist and more are coming, but almost all of them end
at "an arbiter decides" without anyone to fill that seat. The ERC-8183 reference
implementation ships an evaluator *stub* and calls evaluator design "the hardest
part". Evaluators that exist elsewhere either ask an LLM (not reproducible) or
compare against an answer the buyer already had. On Arc we measured the ERC-8004
ValidationRegistry directly: 251 validation responses from 251 distinct addresses,
none of which answered twice. No validator service exists there today.

## What we built

- **The ruling engine.** The buyer commits the tests by hash; the seller commits the
  delivery by hash. Verdict fetches both, checks them against the commitments,
  re-runs the tests in a sandbox, and signs the result. There are three outcomes:
  `passed`, `failed` and `abstain`. If it can't verify honestly (content swapped after
  commitment, unfetchable, malformed), it refuses to move anyone's money.
- **An arbiter API for any escrow.** `POST /v1/rulings` takes terms and a delivery
  and returns a signed ruling plus an EIP-712 attestation bound to one escrow
  contract, one case and the exact commitments. It can charge $0.01 per ruling
  through Circle Gateway (x402), with the same price for every outcome, so there is
  no reason to lean either way.
- **`VerdictRuling`, an on-chain verifier library** any escrow can drop in, and
  **`ArbitratedEscrow`**, a reference escrow that settles on a Verdict attestation.
  The tests prove it refuses forged signers, attestations made for another escrow,
  rulings about a different delivery, malleable signatures, and abstains trying to
  move money.
- **`AgenticCommerce`**, an ERC-8183 escrow for Arc, since none existed, plus an
  evaluator service that watches it and settles jobs that name Verdict. No owner, no
  admin keys, and an immutable fee capped at 2.5%.
- **Reproducibility.** `npm run verify -- <jobId>` rebuilds any ruling from chain
  data alone and re-runs it, with no keys and no trust in us.

## How Arc and Circle are load-bearing

| Circle / Arc component | How we use it |
|---|---|
| **Arc** | Contracts deployed and real cases settled on Arc testnet; sub-second deterministic finality means a ruling settles as soon as it's made |
| **USDC** | Every escrow, payout and refund is USDC, and gas is USDC |
| **Gateway / Nanopayments (x402)** | Rulings are paid per call through Circle's facilitator; verified issuing a correct challenge on `eip155:5042002` for $0.01 |
| **ERC-8183 / ERC-8004** | Verdict holds the ERC-8183 evaluator seat and answers ERC-8004 validation requests |

We settle through Circle's payment layer rather than our own. An early version used
custom payment channels, which we dropped once Nanopayments covered the need. Our
contribution is the part Circle's agent stack leaves open: deciding who gets paid.

## Evidence of shipping

We have no paying users yet, and say so plainly. What exists today:

- **Live on Arc testnet:** `AgenticCommerce` at `0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d`,
  evaluator `0x668640c4f897F55661139D153Feee8b989d5d100`.
- **Two real cases settled end to end** with three distinct keys: one passed and
  paid, one failed and refunded. Every transaction is linked in
  `docs/live-run/LIVE-RUN.md`, and both pass independent re-verification.
- **190 automated tests**, most of them adversarial.
- **Adversarial security reviews before each deployment.** The first two found and
  fixed one critical, one high, three medium and two low-severity issues, including
  a payer being able to destroy $93 of a provider's earned funds for 1 wei,
  reproduced on a real chain before the fix.
- Product site: [site URL]. Source: [repository URL].

## Milestones

| # | Milestone | Verifiable by | Ask |
|---|---|---|---|
| 1 | **Hosted arbiter on Arc testnet.** The arbiter API and the ERC-8183 evaluator service run around the clock with container isolation, and a public page lists every ruling | Anyone requests a ruling or posts a job naming Verdict and watches it settle; `verify` passes | [$5k] |
| 2 | **Two escrow integrations.** Two escrow protocols or marketplaces on Arc settle disputes with `VerdictRuling` | Settlements from contracts we don't control, on Arc testnet | [$10k] |
| 3 | **Accountability.** Verdict bonds USDC per ruling; a challenge window lets anyone re-run and dispute; a ruling proven wrong is slashed to the wronged party | Contracts, an adversarial audit, and a demonstrated successful challenge on testnet | [$12.5k] |
| 4 | **Mainnet.** Paid rulings over Gateway, durable state, and 3 external teams sending real cases | Mainnet addresses; rulings for addresses we don't control | [$7.5k] |

**Total ask: [$35k]**, disbursed per milestone. The first milestone is deliberately
small: it's the one we can verify fastest.

## Why now, and why us

Arc's mainnet is new and the agent stack is being built now. The referee seat is
structurally vacant: it can't be self-served, because a party with a stake in the
outcome can't be its own judge, and escrow builders need someone else to hold it. We
would rather be there on day one with audited, working, reproducible infrastructure
than arrive once the pattern has set.

## Honest risks

- Agent-to-agent job volume is early everywhere, not only on Arc. Milestones 2 and 4
  are gated on usage by teams we don't control, for that reason.
- Re-execution verifies only checkable work: code, computation and data transforms.
  It does not judge subjective quality, and Verdict abstains rather than pretend.
- Until milestone 3 ships, Verdict is trusted rather than trustless. Rulings are
  signed and reproducible, so cheating is detectable, but it isn't yet punished.

## Team

[Founder name, background, and links.] Technical ownership: the full stack in this
repository, including contracts, arbiter, sandbox, payment integration and tests.

## Contact

[Email] · [repository URL] · [Arc address for disbursement]
