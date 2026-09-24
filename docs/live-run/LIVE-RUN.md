# Live run on Arc testnet

Run at 2026-09-24T08:37:12.904Z against [AgenticCommerce](https://explorer.testnet.arc.io/address/0x9d8dbdb27124e7e858c1e22a4ec94160fcafc76d) on Arc testnet (chain 5042002).

Three distinct keys play client, provider and evaluator. The job spec lives in the
job's on-chain description and the deliverable in `submit`'s calldata, both as
content-addressed `data:` URIs, so the verdict can be re-derived from the chain alone.
Each verdict file's hash is the `reason` committed on-chain by `complete`/`reject`.

| party | address |
|---|---|
| client | [`0x817Bbc1726a81ef360f8971186Df8AaE0682BE38`](https://explorer.testnet.arc.io/address/0x817Bbc1726a81ef360f8971186Df8AaE0682BE38) |
| provider | [`0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f`](https://explorer.testnet.arc.io/address/0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f) |
| evaluator | [`0x668640c4f897F55661139D153Feee8b989d5d100`](https://explorer.testnet.arc.io/address/0x668640c4f897F55661139D153Feee8b989d5d100) |

## Job #1 — correct implementation

**PASSED** — 3/3 tests passed. Final status: `Completed`.

| step | transaction |
|---|---|
| `createJob` | [`0x694f32c21c9517e0…`](https://explorer.testnet.arc.io/tx/0x694f32c21c9517e001ded848259f280aaf940b134de4d49976f9d5e5ed7141ac) |
| `setBudget` | [`0x7f4d251795f31576…`](https://explorer.testnet.arc.io/tx/0x7f4d251795f31576b736058447bcc2efe09906895059cebecb9816c0d4e8bb73) |
| `approve` | [`0xe77c3d332968c7ee…`](https://explorer.testnet.arc.io/tx/0xe77c3d332968c7ee3ad4ad33282e799cd81ffa0de0b60a3f89bd8038c03cda32) |
| `fund` | [`0xbe246897ee6dacc2…`](https://explorer.testnet.arc.io/tx/0xbe246897ee6dacc28c7967c08b15b870a57176271a89db48cdcd76dd10d05067) |
| `submit` | [`0x126bf15e02b30e07…`](https://explorer.testnet.arc.io/tx/0x126bf15e02b30e07f07dd875b9c2945a2f7c063afa7338b288975d15cf395c8e) |
| `complete` | [`0x656ebf828d34f0d5…`](https://explorer.testnet.arc.io/tx/0x656ebf828d34f0d529545d25d72148bde5b14b1f8cbf9e325638102f304c2229) |

Sealed verdict: [`docs/live-run/verdict-0xbaa1c2b424c33e404033296aaef003879eb86b66910ffb305fe538a588bc3c95.json`](../../docs/live-run/verdict-0xbaa1c2b424c33e404033296aaef003879eb86b66910ffb305fe538a588bc3c95.json)

## Job #2 — buggy implementation

**FAILED** — 1/3 tests passed. Final status: `Rejected`.

| step | transaction |
|---|---|
| `createJob` | [`0xde744011fe51997a…`](https://explorer.testnet.arc.io/tx/0xde744011fe51997a9e259766d849777d1552dcfda2a2e5e3b197c74d76d62bd6) |
| `setBudget` | [`0x2721e4aedafbf9ae…`](https://explorer.testnet.arc.io/tx/0x2721e4aedafbf9ae8d4f12e1f7a470de6997b188ab7ea50bc0abe6200e5f6dfa) |
| `approve` | [`0xe4cfafd1db2f8c0f…`](https://explorer.testnet.arc.io/tx/0xe4cfafd1db2f8c0f645b55f4506d573e784394b209e54dac3a262f972c7344d4) |
| `fund` | [`0x1b5ad7c6912e1e92…`](https://explorer.testnet.arc.io/tx/0x1b5ad7c6912e1e929050cf4f6981ea41ebfea34ea0effa3e12555b4c89b44be0) |
| `submit` | [`0x8f8c6d045c8acccc…`](https://explorer.testnet.arc.io/tx/0x8f8c6d045c8acccc5b2c7c554d245edd66bfd01d47ad14735a2d5225ef5b879c) |
| `reject` | [`0x6cdc5d694d6df3bc…`](https://explorer.testnet.arc.io/tx/0x6cdc5d694d6df3bca1728bc76a7f94211a701e49d5c65cc797ed734a462cdd05) |
| `claimRefund` | [`0x0f385a068611d4ab…`](https://explorer.testnet.arc.io/tx/0x0f385a068611d4aba3ec3a7b452bb7fc4b177626cbfc02b4fafdfeecd9e656e7) |

Sealed verdict: [`docs/live-run/verdict-0xe5493323564739b37e625fec42405ac7f2b30792f12daad8c62e3204ced913f4.json`](../../docs/live-run/verdict-0xe5493323564739b37e625fec42405ac7f2b30792f12daad8c62e3204ced913f4.json)


## Compute sold through Circle Gateway (x402)

An agent holding the client key bought three sandbox runs from the service, paying
per run over x402 through Circle's Gateway facilitator on Arc testnet. No account,
no API key: the agent deposited USDC into Gateway once and signed an offchain
authorization per call, so it paid no gas per call.

| step | detail |
|---|---|
| Gateway deposit | $1.00 — [`0x54b02f440598340d…`](https://explorer.testnet.arc.io/tx/0x54b02f440598340df5c6eb5676524ab5837f36835d0b9dedafd510f15e644ca8) |
| run 1 (python, 3s timeout) | paid $0.0017, HTTP 200 |
| run 2 (javascript, 2s timeout) | paid $0.0012, HTTP 200 |
| run 3 (python, 2s timeout) | paid $0.0012, HTTP 200 |
| agent Gateway balance | $1.0000 -> $0.9959 |

Each charge equals the service's quote for the requested timeout. The seller
(`0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f`) is credited when Circle settles
the batch, which is asynchronous. Reproduce with `node --env-file=.env demo/pay-x402.js`.
