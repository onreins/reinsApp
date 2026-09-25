/**
 * Does the Arc USDC/EURC pool actually offer anything to trade?
 *
 *   node research/analyse-fx.js
 *
 * Reads the swap history collected by collect-pool-history.js and answers three
 * questions, in order of how much they matter:
 *
 *  1. Do returns mean-revert at all? If the autocorrelation of returns sits
 *     inside the noise floor, the price is a random walk and no reversion
 *     strategy can pay for its own fees, however it is tuned. That verdict
 *     comes before any backtest, because a backtest will always find some
 *     parameter that looks profitable on one day of data.
 *  2. How far does the price actually travel? A round trip costs 10bp in pool
 *     fees alone, so moves smaller than that are unreachable.
 *  3. What would each strategy have earned, net of costs?
 *
 * Nothing here is tuned to look good. The point is to find out whether the
 * agent is worth building at all.
 */
import { readFileSync, writeFileSync } from "node:fs";

const IN = "research/data/eurc-mainnet.ndjson";
const OUT = "research/data/fx-findings.json";

const Q96 = 2 ** 96;
const POOL_FEE_BPS = 5; // 0.05% per swap, so 10bp for a round trip
const GAS_USD = 0.002; // an Arc swap, measured
const BLOCKS_PER_BAR = 120; // ~60s at Arc's half-second blocks
const SECONDS_PER_BLOCK = 0.5;

/** USD per EURC. currency0 is USDC and currency1 is EURC, both 6 decimals. */
const priceOf = (sqrtPriceX96) => 1 / (Number(sqrtPriceX96) / Q96) ** 2;

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function autocorrelation(xs, lag) {
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    den += (xs[i] - m) ** 2;
    if (i + lag < xs.length) num += (xs[i] - m) * (xs[i + lag] - m);
  }
  return den === 0 ? 0 : num / den;
}

/** Last price in each fixed block window, carried forward across quiet bars. */
function toBars(swaps, blocksPerBar) {
  const bars = [];
  let cursor = 0;
  let last = priceOf(swaps[0].sqrtPriceX96);
  for (let start = swaps[0].block; start <= swaps.at(-1).block; start += blocksPerBar) {
    const end = start + blocksPerBar;
    let traded = false;
    while (cursor < swaps.length && swaps[cursor].block < end) {
      last = priceOf(swaps[cursor].sqrtPriceX96);
      cursor += 1;
      traded = true;
    }
    bars.push({ block: start, price: last, traded });
  }
  return bars;
}

/**
 * Two states: all dollars, or all euros. Switch when the signal says the euro
 * is cheap or dear against `reference`. Costs are charged on every switch.
 */
function backtest({ bars, reference, thresholdBps, startUsd = 1000 }) {
  let usd = startUsd;
  let eurc = 0;
  let trades = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const ref = reference(i);
    if (ref === null) continue;
    const { price } = bars[i];
    const devBps = ((price - ref) / ref) * 10_000;

    // Euro cheap against the reference: buy it. Dear: sell back to dollars.
    if (devBps < -thresholdBps && usd > 0) {
      eurc = ((usd * (10_000 - POOL_FEE_BPS)) / 10_000 - GAS_USD) / price;
      usd = 0;
      trades += 1;
    } else if (devBps > thresholdBps && eurc > 0) {
      usd = (eurc * price * (10_000 - POOL_FEE_BPS)) / 10_000 - GAS_USD;
      eurc = 0;
      trades += 1;
    }
  }
  const final = usd + eurc * bars.at(-1).price;
  return { netPct: ((final - startUsd) / startUsd) * 100, trades, endedHolding: eurc > 0 ? "EURC" : "USDC" };
}

function emaReference(bars, span) {
  const k = 2 / (span + 1);
  const out = new Array(bars.length).fill(null);
  let ema = bars[0].price;
  for (let i = 0; i < bars.length; i += 1) {
    ema = bars[i].price * k + ema * (1 - k);
    // Only trust the average once it has seen a full span of bars.
    out[i] = i >= span ? ema : null;
  }
  return out;
}

function main() {
  const swaps = readFileSync(IN, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .sort((a, b) => a.block - b.block);

  if (swaps.length < 50) throw new Error(`only ${swaps.length} swaps collected; run collect-pool-history.js first`);

  const spanBlocks = swaps.at(-1).block - swaps[0].block;
  const hours = (spanBlocks * SECONDS_PER_BLOCK) / 3600;
  const sizes = swaps.map((s) => Math.abs(Number(s.amount0)) / 1e6).sort((a, b) => a - b);
  const volumeUsd = sizes.reduce((a, b) => a + b, 0);
  const prices = swaps.map((s) => priceOf(s.sqrtPriceX96));
  const low = Math.min(...prices);
  const high = Math.max(...prices);

  console.log(`\n  ARC MAINNET USDC/EURC — what is actually there\n`);
  console.log(`  swaps               ${swaps.length}`);
  console.log(`  blocks              ${spanBlocks} (~${hours.toFixed(1)} hours)`);
  console.log(`  swaps per hour      ${(swaps.length / hours).toFixed(1)}`);
  console.log(`  USDC volume         $${volumeUsd.toFixed(0)}  (median trade $${sizes[Math.floor(sizes.length / 2)].toFixed(2)})`);
  console.log(`  price               $${low.toFixed(6)} … $${high.toFixed(6)}`);
  console.log(`  total travel        ${(((high - low) / mean(prices)) * 10_000).toFixed(1)} bp\n`);

  const bars = toBars(swaps, BLOCKS_PER_BAR);
  const returns = [];
  for (let i = 1; i < bars.length; i += 1) returns.push((bars[i].price - bars[i - 1].price) / bars[i - 1].price);

  const sd = Math.sqrt(mean(returns.map((r) => (r - mean(returns)) ** 2)));
  console.log(`  ${bars.length} one-minute bars, ${bars.filter((b) => b.traded).length} with a trade in them`);
  console.log(`  per-bar move        ${(sd * 10_000).toFixed(2)} bp (1 sd)`);
  console.log(`  round trip costs    ${POOL_FEE_BPS * 2} bp in fees + $${(GAS_USD * 2).toFixed(3)} gas\n`);

  // Most one-minute bars hold no trade, so their price is carried forward and
  // contributes a false zero return. Measuring swap-to-swap as well removes
  // that bias: in event time every observation is a real price change.
  const eventReturns = [];
  for (let i = 1; i < prices.length; i += 1) eventReturns.push((prices[i] - prices[i - 1]) / prices[i - 1]);

  console.log(`  RETURN AUTOCORRELATION — negative means reversion, ~0 means a random walk`);
  const series = { clock: returns, event: eventReturns };
  const acf = { clock: {}, event: {} };
  const noise = { clock: 2 / Math.sqrt(returns.length), event: 2 / Math.sqrt(eventReturns.length) };
  for (const [label, xs] of Object.entries(series)) {
    console.log(
      `    ${label === "clock" ? "one-minute bars" : "swap to swap   "}  n=${String(xs.length).padStart(5)}  ` +
        `noise floor ±${noise[label].toFixed(4)}`,
    );
    for (const lag of [1, 2, 3, 5, 10, 20]) {
      const a = autocorrelation(xs, lag);
      acf[label][lag] = a;
      const verdict = Math.abs(a) < noise[label] ? "" : a < 0 ? "  reversion" : "  momentum";
      const bar = "#".repeat(Math.min(30, Math.round(Math.abs(a) * 200)));
      console.log(`      lag ${String(lag).padStart(2)}  ${a >= 0 ? " " : "-"}${Math.abs(a).toFixed(4)}  ${bar}${verdict}`);
    }
  }
  console.log("");

  const strategies = [];
  const holdEurc = ((bars.at(-1).price - bars[0].price) / bars[0].price) * 100;
  strategies.push({ name: "hold USDC", netPct: 0, trades: 0, endedHolding: "USDC" });
  strategies.push({ name: "hold EURC", netPct: holdEurc, trades: 1, endedHolding: "EURC" });

  // The agent as written today: revert towards the oracle. Chainlink moves only
  // on a 0.5% deviation, so across a day it is very nearly a constant.
  const oracle = mean(prices);
  for (const t of [15, 25, 50]) {
    strategies.push({
      name: `today's agent — revert to oracle, ${t}bp`,
      ...backtest({ bars, reference: () => oracle, thresholdBps: t }),
    });
  }

  // The honest alternative: revert towards the pool's own recent average.
  for (const span of [15, 60, 240]) {
    const ref = emaReference(bars, span);
    for (const t of [10, 20, 40]) {
      strategies.push({
        name: `revert to ${span}min average, ${t}bp`,
        ...backtest({ bars, reference: (i) => ref[i], thresholdBps: t }),
      });
    }
  }

  console.log(`  WHAT EACH WOULD HAVE EARNED over ${hours.toFixed(1)}h on $1,000, after fees and gas\n`);
  console.log(`    ${"strategy".padEnd(42)} ${"net".padStart(8)}  ${"trades".padStart(6)}  ended`);
  for (const s of [...strategies].sort((a, b) => b.netPct - a.netPct)) {
    console.log(
      `    ${s.name.padEnd(42)} ${`${s.netPct >= 0 ? "+" : ""}${s.netPct.toFixed(3)}%`.padStart(8)}  ` +
        `${String(s.trades).padStart(6)}  ${s.endedHolding}`,
    );
  }

  const best = strategies.filter((s) => !s.name.startsWith("hold")).sort((a, b) => b.netPct - a.netPct)[0];
  const reverts = acf.event[1] < -noise.event;
  // Reversion is only worth anything if the swing is bigger than the toll.
  const swingBps = sd * 10_000;
  const harvestable = reverts && swingBps > POOL_FEE_BPS * 2;
  // The takers' fees all land on the other side of the trade.
  const lpFeesUsd = (volumeUsd * POOL_FEE_BPS) / 10_000;

  console.log(`\n  VERDICT`);
  console.log(
    `    reversion, swap to swap   ${reverts ? "YES" : "no"} ` +
      `(${acf.event[1].toFixed(4)} against a ±${noise.event.toFixed(4)} noise floor)`,
  );
  console.log(`    size of the swing         ${swingBps.toFixed(2)} bp, against a ${POOL_FEE_BPS * 2} bp round trip`);
  console.log(`    harvestable as a taker    ${harvestable ? "yes" : "NO — the swing is smaller than the fee"}`);
  console.log(`    best strategy             ${best.name}, ${best.netPct >= 0 ? "+" : ""}${best.netPct.toFixed(3)}%`);
  console.log(
    `    beats holding USDC        ${best.netPct > 0 ? "yes" : "NO"} · beats holding EURC ${best.netPct > holdEurc ? "yes" : "NO"}`,
  );
  console.log(`    fees paid to LPs          $${lpFeesUsd.toFixed(2)} over ${hours.toFixed(1)}h — the money is on the maker side\n`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        swaps: swaps.length,
        hours: Number(hours.toFixed(2)),
        swapsPerHour: Number((swaps.length / hours).toFixed(1)),
        volumeUsd: Number(volumeUsd.toFixed(2)),
        medianTradeUsd: Number(sizes[Math.floor(sizes.length / 2)].toFixed(2)),
        bars: bars.length,
        perBarMoveBps: Number((sd * 10_000).toFixed(3)),
        roundTripCostBps: POOL_FEE_BPS * 2,
        autocorrelation: acf,
        noiseFloor: noise,
        meanReverts: reverts,
        strategies,
        analysedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  wrote ${OUT}\n`);
}

main();
