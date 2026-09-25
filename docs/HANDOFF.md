# CTO handoff

Living status for whoever picks this up next — including a future session of
the agent that wrote it. Update it at the end of every working stretch.

## Current product: Mandate (since 2026-09-25)

The founder judged Verdict too weak on demand and chose **Mandate**: a smart
contract that holds an AI agent's USDC under rules it cannot break (Arc Request
for Builders item 12). Built so far, all on `master`:

| | |
|---|---|
| Contract | `contracts/Mandate.sol` + factory. 24 adversarial tests; reviewed, findings fixed |
| Exchange | `contracts/UniswapV4Venue.sol`, per-pair routes set once. Proven on Arc mainnet state with `npm run sim:mainnet` (no spend) |
| Arena | `npm run arena` — leaderboard + per-agent history, read from chain events only; 7 tests |
| Agent surface | `mandate/sdk.js`, `mandate/mcp-server.js` (MCP tools), `agents/fx-reversion.js` |
| Mainnet | Not deployed. `npm run deploy:mandate -- --dry-run` estimates ~$0.10 gas. Deployer is a fresh key `0x75Ff1C11FfFECF6EAF4fDc7f7d11df5b77674f41` (`MANDATE_MAINNET_KEY` in `.env`), unfunded |
| Market reality | Only USDC/EURC has a liquid v4 pool on Arc mainnet (checked 2026-09-25); ETH/BTC have no pool yet, so v1 is an FX agent |

**Blocked on the founder:** funding the mainnet deployer with real USDC (~$25:
deploy + a small first mandate + agent gas).

Next: deploy, run one live mandate with the reference agent, then point the
arena at mainnet and wire an LLM agent through the MCP server.

## What Verdict was

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
| Contracts on Arc testnet | `AgenticCommerce` `0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d`, `ArbitratedEscrow` `0xdcfaf4d8be9eedf12fe4b0b4ceafb9d1d580f794`, `RatchetVault` `0x2dcf3df463b194844bb7496ea7d32174339fc936` |
| Live verified jobs | 2 — one passed and paid, one failed and refunded. See [live-run/LIVE-RUN.md](live-run/LIVE-RUN.md) |
| Independent verification | `npm run verify -- 1` re-derives a verdict from chain data alone; both jobs pass every check — confirmed from a fresh clone with no `.env` |
| Evaluator service | `npm run evaluator` — watches Arc, judges jobs naming its key, resumes safely after restarts; smoke-tested against the live contract |
| Arbiter API | `npm run arbiter` — any escrow sends terms + delivery, gets a signed ruling and an EIP-712 attestation bound to its contract. Optional $0.01/ruling over x402. SSRF-guarded fetching. Smoke-tested with the live evaluator key; not hosted yet |
| On-chain verifier | `VerdictRuling` library + `ArbitratedEscrow` reference escrow, live on Arc testnet at `0xdcfaf4d8be9eedf12fe4b0b4ceafb9d1d580f794`. Two live cases settled through the arbiter API (one paid, one refunded): [live-run/ARBITER-RUN.md](live-run/ARBITER-RUN.md) |
| Tests | 192 passing (`npm test`, needs `npm run chain` in another terminal) |
| Audits | Two adversarial passes on the original contracts (fixed: 1 critical, 1 high, 3 medium, 2 low). A third pass on the arbiter and escrow (fixed: 1 critical SSRF bypass via IPv6 notation, 2 high resource-exhaustion issues, 1 medium paid-then-500; 1 medium reclaim/settle ordering race documented as inherent) |
| Payments | Settled end to end. Across two runs an agent bought 6 sandbox runs over x402 through Circle Gateway on Arc testnet; the buyer's Gateway balance went $1.0000 → $0.9918 and the seller's rose to exactly $0.0082 once Circle's batch cycle completed (checked 2026-09-25) |
| Website | `site/index.html`, published as a private claude.ai artifact. Rewritten for Mandate 2026-09-25 in an institutional register — hairline rules, tabular numerals, no rounded corners, one accent. `arena/public/index.html` matches it. Missing: contact email, repo link |

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
   Four drafted messages, unsent, are in [OUTREACH.md](OUTREACH.md). Best first
   targets: escrow protocols with a pluggable arbiter slot.
4. **Website contact details.** It has no contact email and no repo link on purpose;
   both need the founder's say.

## Secrets

`.env` holds the deployer, provider and evaluator keys. It is gitignored and has been
verified absent from every commit. The deployer key was pasted into a chat
transcript, so it is testnet-only and must never hold real value. Rotate before any
mainnet use.

## Next engineering steps, in order

1. **Host the arbiter and the evaluator service** somewhere always-on, with Docker
   isolation and a public page listing rulings — grant milestone 1. Needs a host
   account, which is a human decision.
2. **Staking and challenge windows** for evaluator accountability — the problem the
   ecosystem's own write-ups call unsolved; grant milestone 3.
3. Docker isolation on by default; warm sandbox pool to cut Python cold start (~500ms).
4. Durable ledger (Postgres) for the Ratchet path — a crash loses unsettled vouchers.
   Lower priority now that Circle Gateway is the headline payment path.

## Arc facts measured the hard way

- Public RPC refuses `eth_getLogs` over 9,999 blocks, and rejects OR-of-event topic
  filters. All log reads page and filter locally.
- viem caches `getBlockNumber` ~4s; at 0.5s blocks that hides ~8 blocks. Read head
  with `cacheTime: 0`.
- USDC ERC-20 is `0x3600000000000000000000000000000000000000` on testnet and mainnet.

## Session log

- **2026-09-25 (evening)** — the founder judged the site unprofessional. Two causes:
  it still sold Verdict, and the arena looked like a consumer app. Rewrote
  `site/index.html` around Mandate and restyled `arena/public/index.html` to the same
  system — Inter Tight + IBM Plex Mono, near-black ink, one blue accent, hairline
  rules, tabular numerals, zero rounded corners, data in tables rather than cards.
  The arena leaderboard is now a seven-column table that folds to four on a phone.
  239 tests still pass.
- **2026-09-25** — built the product website (published privately; several design
  rounds, final: Aino-inspired hero, Tempo-style body, real data only). Built the
  arbiter API for any escrow, EIP-712 attestations, the `VerdictRuling` on-chain
  verifier and `ArbitratedEscrow` reference escrow, and an SSRF-guarded fetcher; 50
  new tests (192 total). An adversarial review found a critical SSRF bypass and three
  more issues, all fixed with regression tests. Deployed `ArbitratedEscrow` to Arc
  testnet and settled two live cases through the arbiter API. Confirmed Circle
  Gateway settled the x402 payments to the seller. Rewrote the grant draft around the
  arbiter ([$35k], smaller first milestone). Closed the DNS-rebinding gap: the
  arbiter's fetches re-check the address inside the socket's own lookup. Testnet
  spend today: ~$0.12.
- **2026-09-24** — deployed to Arc testnet; ran two verified jobs; built the
  chain-only verifier; built the evaluator daemon; bought compute through Circle
  Gateway; drafted the grant. Two real bugs found and fixed along the way (RPC log
  range limit, stale cached head). Testnet spend so far: ~$1.25 of the $20 faucet
  grant, $1 of it sitting in Gateway.
