# Mandate on Arc testnet: a live run

*Run 2026-09-25T09:32:15.868Z · chain 5042002 · every line below is a real transaction.*

## What this proves

A mandate held real testnet USDC. An agent traded it through the real Uniswap v4
PoolManager, and the contract refused every trade that broke a rule — on-chain,
with a hash you can open. A stranger who owns none of it froze the mandate once
it fell through its floor. The owner took money out while the agent was still
running.

## The deployment

| | |
|---|---|
| MandateFactory | [`0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82`](https://explorer.testnet.arc.io/address/0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82) |
| UniswapV4Venue | [`0x007d5ad07b7a97fefcbd4302dfeafc11d8485052`](https://explorer.testnet.arc.io/address/0x007d5ad07b7a97fefcbd4302dfeafc11d8485052) |
| PinnedFeed | [`0xfdde6a331c996d6fddbdce108ba18fff0b7f972e`](https://explorer.testnet.arc.io/address/0xfdde6a331c996d6fddbdce108ba18fff0b7f972e) |
| The mandate | [`0x991b8687aca6Acd6b92438bb4cE22866827bD632`](https://explorer.testnet.arc.io/address/0x991b8687aca6Acd6b92438bb4cE22866827bD632) |
| Owner | `0x817Bbc1726a81ef360f8971186Df8AaE0682BE38` |
| Agent | `0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f` |
| Pool | USDC/EURC, fee 500, seeded by us with 6 USDC + 5.354321 EURC |

## The run

| # | Step | What happened | Transaction |
|---|---|---|---|
| 1 | pool arbitraged back to the oracle | -80 bps off → -0 bps, selling 0.437846 EURC | [`0xe91b0a83…`](https://explorer.testnet.arc.io/tx/0xe91b0a83bcdfdc16827301fa92d99b8d47b30db87fd459e1e59eea4eec53990d) |
| 2 | mandate created and funded | 0x991b8687aca6Acd6b92438bb4cE22866827bD632 with $2 | — |
| 3 | opening position | equity $2.0000 · floor $1.80 · max $2/trade · within 1% of the oracle | — |
| 4 | agent buys $0.5 of EURC | 0.437411 EURC at $1.143090 — 0.454% vs oracle $1.137925 | [`0xe95e9c7d…`](https://explorer.testnet.arc.io/tx/0xe95e9c7d667af65799cbd3303a7cdc33ab64258fd6c5244a60f6f40782fb86ec) |
| 5 | trade above the $2 limit | refused on-chain: TradeTooLarge | [`0x685d4a90…`](https://explorer.testnet.arc.io/tx/0x685d4a906aefb333041798a22bcef2b95c100d60970307407e860225a486cc5e) |
| 6 | a trade too big for the pool to price fairly | refused on-chain: InsufficientOutput | [`0x0ae7cd48…`](https://explorer.testnet.arc.io/tx/0x0ae7cd48e39945f69f843857e053de0380ea8626b965633a767acb86fb00e6fa) |
| 7 | trade into an asset never allowed | refused on-chain: AssetNotAllowed | [`0x5c50decb…`](https://explorer.testnet.arc.io/tx/0x5c50decbafeee6dcf4ddb98ab6567f8abc0e383d29a9705fd97d10db2305dc5d) |
| 8 | a stranger's key tries to trade | refused on-chain: NotAgent | [`0x48b35a90…`](https://explorer.testnet.arc.io/tx/0x48b35a907b745397ceeaee5343d0ce56c4e30f36071cf5caa1ae85cec560a752) |
| 9 | euro falls 50% on the feed | $0.56896254 per EURC | [`0x345f005b…`](https://explorer.testnet.arc.io/tx/0x345f005b0dcb98adae8f256841e71f869aabb2ca9f0e68be2d53d4cf2b78dbbf) |
| 10 | a stranger freezes it | equity $1.9977 → $1.7489, under the $1.80 floor · frozen by 0x668640c4f897F55661139D153Feee8b989d5d100, who owns none of it | [`0x3cafe35c…`](https://explorer.testnet.arc.io/tx/0x3cafe35c4cd93779ad751c050431e97ed771e5b196c1838d2ebc0d5ee8c5dcba) |
| 11 | agent tries to keep trading | refused on-chain: IsFrozen | [`0xddad294e…`](https://explorer.testnet.arc.io/tx/0xddad294e5abc6b6c75ab72c951c43dc56c9889796abec695942071af5090944f) |
| 12 | price restored | $1.137925 per EURC | [`0xbeac9c84…`](https://explorer.testnet.arc.io/tx/0xbeac9c84663acb26e18e745e56a388a9ebb620c9df62e1f84e0cf1657c31cddb) |
| 13 | owner resumes it | frozen = false | [`0xd29eb5f2…`](https://explorer.testnet.arc.io/tx/0xd29eb5f2d90d62f95cca0b9c060c7a5542aa9e982b2fb4676fa0f20a9ca136c3) |
| 14 | owner withdraws mid-strategy | $0.25 out of $1.5 USDC held, without asking the agent | [`0x0c437da1…`](https://explorer.testnet.arc.io/tx/0x0c437da13266ecb46aca336076f6149359312ae85ca079f1735feeefb7e0c2e5) |
| 15 | closing position | equity $1.7477 · holds 1.2500 USDC + 0.4374 EURC | — |

## Two honest differences from mainnet

1. **The oracle.** Chainlink publishes 32 feeds on Arc mainnet and none on Arc
   testnet. So the mandate here reads `PinnedFeed`, which carries the live
   mainnet EURC/USD answer and is moved by us — that is how the crash in step
   9 was staged. On mainnet the mandate is handed Chainlink's own
   aggregator and `PinnedFeed` is not deployed at all.
2. **The market.** Arc mainnet has a liquid USDC/EURC pool. Testnet had none, so
   we created one and funded it out of our own testnet balance. It is only a few
   dollars deep, which is why a $1 trade cannot be priced inside the mandate's
   1% band while a $0.5 trade can, and why the pool has to be arbitraged
   back to the oracle by us. The PoolManager, the PositionManager and the swap
   path are Uniswap's real contracts; only the liquidity is ours.

Neither difference touches the Mandate contract. The rules that refused those
trades are the same bytecode that would run on mainnet, which is what
`npm run sim:mainnet` exercises against the real mainnet pool.
