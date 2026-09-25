# Can an agent make money trading USDC/EURC on Arc?

**No. Not as a taker, at any tuning.** Measured 2026-09-25 over 23.8 hours of
live Arc mainnet data. Reproduce with:

```bash
node research/collect-pool-history.js --blocks 172800
node research/analyse-fx.js
```

## What the pool actually does

| | |
|---|---|
| Swaps | 737 in 23.8 hours (31/hour) |
| Volume | $137,677, median trade $25 |
| Price range, whole day | $1.136739 – $1.140571 — **33.7 bp**, total |
| Typical move per minute | **0.48 bp** (1 sd) |
| Cost of a round trip | **10 bp** in pool fees, plus ~$0.004 of gas |

That last pair is the whole story. The price wanders less in a minute than a
round trip costs, and its entire range across a full day is barely three round
trips wide.

## There is real mean reversion, and it is unreachable

Swap-to-swap returns have a lag-1 autocorrelation of **−0.1187** against a
±0.0737 noise floor. That is genuine, statistically significant reversion — the
bid-ask bounce of buys and sells alternating around a mid price.

It is also worth nothing to us. The bounce is a fraction of a basis point wide;
crossing the spread to capture it costs 10 bp. The swing would have to be
twenty times larger before the trade paid for itself.

Measured on one-minute bars the reversion disappears entirely (−0.0292 to
+0.0397, all inside a ±0.0530 noise floor). At every horizon an agent could
actually act on, this price is a random walk.

## Every strategy we tested made exactly zero trades

| strategy | net over 23.8h on $1,000 | trades |
|---|---|---|
| hold EURC | **+0.234%** | 1 |
| hold USDC | 0.000% | 0 |
| today's agent — revert to oracle, 15 / 25 / 50 bp | 0.000% | **0** |
| revert to 15 / 60 / 240-minute average, 10 / 20 / 40 bp | 0.000% | **0** |

Zero is not a bug. No reference price and no threshold at or above the 10 bp
cost of trading was ever crossed, because the price never travels that far from
its own recent average. The best thing to do all day was buy euros and sit
still, and that only worked because EUR/USD happened to drift.

## Why the original agent was wrong

`agents/fx-reversion.js` treats Chainlink's EURC/USD as fair value and trades
the pool's deviation from it. Two problems:

1. **The oracle is not precise enough to be a signal.** It updates on a 0.5%
   deviation threshold, so by design it is accurate to roughly ±50 bp. Trading a
   15 bp "deviation" from it is reading noise inside the oracle's own tolerance.
2. **There is no deviation to trade.** The pool stays within 34 bp of itself all
   day. Arbitrageurs with exchange access keep it pinned, and they are faster
   than us and pay less.

This does not make the oracle useless. It makes it a **guardrail** rather than a
signal — exactly the right tool for refusing a bad fill, which is what
`Mandate.sol` uses it for, and the wrong tool for deciding a trade.

## Where the money in this pool actually is

Takers paid **$68.84** in fees over the day, and all of it went to liquidity
providers. The only profitable seat at this table is the one making the market,
not the one crossing the spread — and that is a different product, with
inventory risk, not something a Mandate's `trade()` can express.

## What this means

A trading agent is not the way to show Mandate off on Arc today:

- The one pair with an oracle has no exploitable movement.
- The 287 pools that *do* move have no oracle, so a Mandate cannot price them
  safely, and dropping the oracle check would gut the guarantee we are selling.

The constraint is the market, not the contract. Mandate itself is unaffected by
any of this — it did its job correctly in every test, on testnet and in
simulation against mainnet. What needs rethinking is what we put inside it: an
agent that **spends** money under constraints has a real job to do here; an
agent that tries to **make** money on this pair does not.

---

# Follow-up: is there a working strategy anywhere on Arc?

Measured 2026-09-25, after the result above. Three seats, all checked.

## 1. Taker on USDC/EURC — no

Covered above. The price moves 0.48 bp per minute against a 10 bp round trip.

## 2. Maker on USDC/EURC — 2.8% APY, worse than doing nothing

The $68.84/day of fees is real, but it is spread across real capital. Walking
the initialised ticks either side of spot, liquidity spans −622 to +553 bp and
holds roughly **413,059 USDC + 431,358 EURC ≈ $905k**.

$68.84 × 365 ÷ $905k = **2.8% APY, before impermanent loss.**

USYC — Circle's tokenized T-bill, already on Arc — pays more than that with no
FX risk and no inventory. Market making this pair is worse than holding cash.

## 3. Something volatile — there is no market

Arc has 32 Chainlink feeds, including BTC/USD, ETH/USD, SOL, XRP, AVAX, LINK,
UNI, AAVE, HYPE and PAXG. It does not have the pools to go with them:

| pool | state |
|---|---|
| USDC/cirBTC, fee 100 | initialised, **liquidity 0** |
| USDC/WETH | never initialised, any fee tier |
| cirBTC/WETH | never initialised |
| USDC/USYC | never initialised |
| USDC/EURC, fee 500 | the only pool with liquidity |

Those feeds exist for lending protocols — AAVE runs on Arc, and one of the
feeds is literally "AAVE Network Emergency Count (Arc)" — not for traders.

## What Arc is actually used for

In a 175-minute window: **758 new pools created, 58,381 swaps**, and 478 of the
new pools sit behind a hook. Nearly every one is USDC against a freshly minted
token. Pools involving WETH or cirBTC: **two**.

Arc is a token-launch chain. That is where all the volume is, and none of those
tokens has a price feed.

## The conclusion

There is no profitable trading strategy available to a Mandate on Arc today,
and this is a fact about the market, not about our tuning. Anyone claiming an
FX alpha story on Arc has not measured the pool.

That leaves two honest directions, and both are about what we put in the safe
rather than the safe itself:

1. **An agent that spends under constraints** — pays for compute, settles
   invoices, converts USDC to EURC to pay a European supplier. Needs no alpha
   and no volatile market to be worth having.
2. **A budget-capped Mandate with no oracle**, pointed where the volume is. For
   an unpriced asset you cannot check a fair price, but you do not need to: a
   hard cap on USDC spent bounds the loss exactly, measured on the way out
   rather than valued on the way in. The agent may spend at most $X total and
   $Y per trade on approved venues, everything it buys stays in the contract,
   and only the owner can withdraw. Loss is bounded by the budget.

Option 2 is not an alpha strategy and must never be sold as one — most launch
tokens go to zero. It is a containment demonstration, which is what "money with
a mandate" actually means.
