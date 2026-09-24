# CTO handoff

Living status for whoever picks this up next — including a future session of
the agent that wrote it. Update it at the end of every working stretch.

## What this is

**Verdict**: a neutral evaluator for agent work on Arc. ERC-8183 lets one agent
hire another with escrowed USDC, and a named *evaluator* decides whether the
work is released or refunded. The standard lets the client name themselves,
and Circle's own quickstart does — so the buyer marks their own homework.
Verdict fills that seat with something that has nothing to gain from the answer:
it re-runs the delivered code against tests both sides agreed to up front, and
abstains rather than guessing when it cannot verify.

## State of play

| | |
|---|---|
| Contracts on Arc testnet | `AgenticCommerce` `0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d`, `RatchetVault` `0x2dcf3df463b194844bb7496ea7d32174339fc936` |
| Live verified jobs | 2 — one passed and paid, one failed and refunded. See [live-run/LIVE-RUN.md](live-run/LIVE-RUN.md) |
| Independent verification | `npm run verify -- 1` re-derives a verdict from chain data alone; both jobs pass every check |
| Tests | 136 passing (`npm test`, needs `npm run chain` in another terminal) |
| Audits | Two adversarial passes. Found and fixed: 1 critical, 1 high, 3 medium, 2 low |
| Payments | Sandbox service settles through Circle Gateway Nanopayments (x402), verified against Circle's live testnet facilitator |

## Decisions and why

- **Settle through Circle, not our own channel.** Circle's Nanopayments already do
  batched sub-cent USDC on Arc, gaslessly. Shipping a competing payment layer into a
  Circle grant reads as duplicating their stack. `RatchetVault` stays as a working
  demonstration of the mechanism, not the headline.
- **Deploy our own ERC-8183.** Arc has none — ERC-8004's registries are on testnet
  only and absent from mainnet — so there was nowhere to run a real job.
- **No owners, no admin keys, immutable fee capped at 2.5%.** An autonomous agent
  cannot safely commit funds to a contract whose rake can change.
- **Abstain is a first-class outcome.** An evaluator that guesses under uncertainty
  is worse than none, because both parties relied on it.
- **Job inputs live on-chain as content-addressed `data:` URIs**, so no server of
  ours has to stay up for anyone to re-check a verdict.

## Honest risks

- **The market is early.** ERC-8183 volume is negligible everywhere; Virtuals ACP,
  the one agent-job market that had volume, fell to ~17 memos/day by Sept 2026.
  x402 pay-per-call is the part with real, growing traffic.
- **Competitors exist off Arc**: UFX (LLM-based evaluators on Base), Amana
  (hash-matching escrow). Neither re-executes work; neither abstains. Nobody runs a
  validator service on Arc (measured: 251 validation responses, 0 repeat responders).
- **The evaluator is trusted, not trustless.** Verdicts are signed and reproducible,
  so cheating is detectable, but nothing stakes or slashes yet.
- **The sandbox's `process` backend is not a security boundary.** Docker is installed
  on the dev machine but its daemon was not running.

## Needs a human

1. **Push to GitHub.** Decision made: public. Blocked on an empty repo existing —
   create one at github.com/new (no README), then `git remote add origin <url>` and
   `git push -u origin master`. Git Credential Manager handles sign-in.
2. **Grant application** — drafted in [GRANT.md](GRANT.md), not submitted. Submitting
   is the founder's call.
3. **Talk to one real user.** Nothing outside this repo has seen the product yet.

## Secrets

`.env` holds the deployer, provider and evaluator keys. It is gitignored and has been
verified absent from every commit. The deployer key was pasted into a chat
transcript, so it is testnet-only and must never hold real value. Rotate before any
mainnet use.

## Next engineering steps, in order

1. Paying agent for the x402 service (Gateway deposit + signed payment) so the
   compute side is demonstrable end to end.
2. Durable ledger (Postgres) for the Ratchet path — a crash loses unsettled vouchers.
3. Staking and challenge windows for evaluator accountability — the problem the
   ecosystem's own write-ups call unsolved.
4. Docker isolation on by default; warm sandbox pool to cut Python cold start (~500ms).
