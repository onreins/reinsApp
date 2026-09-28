/**
 * Strategies on any timeframe, down to the minute: the schema's timeframe
 * fields, resampling minute candles, lining up series from different
 * timeframes without seeing the future, the minute-data files, and the
 * backtester running on them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSpec, describeSpec, needsIntraday } from "../app/strategy/spec.js";
import { backtest, highestPrev, lowestPrev } from "../app/strategy/backtest.js";
import { resample, align, minuteFeed, readMinutes } from "../app/strategy/candles.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const T0 = Date.UTC(2024, 0, 1) / 1000; // a Monday, 00:00 UTC

/** Minute candles from closes: open = previous close, high/low = the minute's extremes. */
function minutes(closes, start = T0) {
  const n = closes.length, o = new Float32Array(n), h = new Float32Array(n), l = new Float32Array(n), c = new Float32Array(n);
  closes.forEach((x, i) => {
    const open = i ? closes[i - 1] : x;
    o[i] = open; c[i] = x; h[i] = Math.max(open, x); l[i] = Math.min(open, x);
  });
  return { start, o, h, l, c };
}
const rules = (extra) => parseSpec({ type: "rules", name: "t", asset: "BTC", ...extra });

describe("the schema, with timeframes", () => {
  const golden = {
    entry: [{ left: { kind: "ema", period: 100, tf: "1m" }, op: "crosses_above", right: { kind: "sma", period: 50, tf: "1d" } }],
    timeframe: "1m",
  };

  test("accepts a timeframe for the strategy and one per series", () => {
    const r = rules(golden);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.spec.timeframe, "1m");
  });

  test("leaves daily strategies exactly as they were", () => {
    const r = rules({ entry: [{ left: { kind: "price" }, op: "above", right: { kind: "sma", period: 200 } }] });
    assert.equal(r.spec.timeframe, undefined);
    assert.equal(needsIntraday(r.spec), false);
  });

  test("refuses a timeframe it doesn't have", () => {
    assert.equal(rules({ ...golden, timeframe: "2m" }).ok, false);
    assert.equal(rules({ entry: [{ left: { kind: "price" }, op: "above", right: { kind: "sma", period: 20, tf: "3h" } }] }).ok, false);
  });

  test("knows when a strategy needs minute prices", () => {
    assert.equal(needsIntraday(rules(golden).spec), true);
    assert.equal(needsIntraday(rules({ entry: [{ left: { kind: "price" }, op: "above", right: { kind: "sma", period: 20, tf: "1h" } }] }).spec), true);
    assert.equal(needsIntraday(rules({ timeframe: "4h", entry: [{ left: { kind: "price" }, op: "above", right: { kind: "sma", period: 20 } }] }).spec), true);
  });

  test("says each series' timeframe in words, and how often it checks", () => {
    assert.deepEqual(describeSpec(rules(golden).spec), [
      "Buy BTC when the 100-minute EMA crosses above the 50-day average.",
      "Sell when that stops being true.",
      "Checks its rules every minute.",
    ]);
    const fives = rules({ timeframe: "5m", entry: [{ left: { kind: "price" }, op: "above", right: { kind: "ema", period: 20 } }] }).spec;
    assert.equal(describeSpec(fives)[0], "Buy BTC when the price is above the 20-candle EMA on 5-minute candles.");
    assert.equal(describeSpec(fives)[2], "Checks its rules every 5 minutes.");
  });
});

describe("the n-period high and low, fast enough for minutes", () => {
  test("match the plain definition on random data", () => {
    const x = Array.from({ length: 500 }, (_, i) => Math.sin(i * 1.7) * 50 + (i % 13));
    for (const n of [2, 7, 40]) {
      const h = highestPrev(x, n), l = lowestPrev(x, n);
      for (let i = 0; i < x.length; i++) {
        if (i < n) { assert.ok(Number.isNaN(h[i]) && Number.isNaN(l[i])); continue; }
        const win = x.slice(i - n, i);
        assert.equal(h[i], Math.max(...win));
        assert.equal(l[i], Math.min(...win));
      }
    }
  });
});

describe("resampling minute candles", () => {
  test("builds UTC-aligned candles: first open, highest high, lowest low, last close", () => {
    const m = minutes(Array.from({ length: 180 }, (_, i) => 100 + i));
    const hr = resample(m, "1h");
    assert.equal(hr.t.length, 3);
    assert.deepEqual([hr.t[0], hr.t[1]], [T0, T0 + 3600]);
    assert.equal(hr.step, 3600);
    near(hr.o[1], 159); near(hr.h[1], 219); near(hr.l[1], 159); near(hr.c[1], 219);
  });

  test("starts a candle on its UTC boundary even when the data starts inside it", () => {
    const m = minutes(Array.from({ length: 90 }, () => 5), T0 + 30 * 60);
    const hr = resample(m, "1h");
    assert.deepEqual(Array.from(hr.t), [T0, T0 + 3600]);
  });
});

describe("lining up timeframes", () => {
  test("a slower series only counts once its candle has closed", () => {
    // Daily values on days 0..2, read by hourly candles over the same days.
    const day = { t: Float64Array.from([T0, T0 + 86400, T0 + 2 * 86400]), step: 86400 };
    const hour = { t: Float64Array.from({ length: 72 }, (_, i) => T0 + i * 3600), step: 3600 };
    const v = align(Float64Array.from([10, 20, 30]), day, hour);
    // Hours 0-22 of day 0 close before day 0 does: nothing yet.
    assert.ok(Number.isNaN(v[0]) && Number.isNaN(v[22]));
    // The 23:00 candle closes at midnight, exactly when day 0 closes.
    assert.equal(v[23], 10);
    assert.equal(v[24], 10);
    assert.equal(v[47], 20);
    assert.equal(v[71], 30);
  });

  test("a faster series is read at the close of the slower candle", () => {
    const min = { t: Float64Array.from({ length: 120 }, (_, i) => T0 + i * 60), step: 60 };
    const hour = { t: Float64Array.from([T0, T0 + 3600]), step: 3600 };
    const v = align(Float64Array.from({ length: 120 }, (_, i) => i), min, hour);
    assert.deepEqual(Array.from(v), [59, 119]);
  });
});

describe("backtesting on minute prices", () => {
  // Three days of minutes: flat at 100, a jump to 200 on day 2 at 12:00, flat after.
  const closes = Array.from({ length: 3 * 1440 }, (_, i) => (i < 2 * 1440 + 720 ? 100 : 200));
  const feed = minuteFeed(minutes(closes));
  const up = { left: { kind: "price" }, op: "above", right: { kind: "value", value: 150 } };

  test("an hourly strategy fills at the next hour's open", () => {
    const { spec } = rules({ timeframe: "1h", entry: [up] });
    const r = backtest(spec, feed, { from: "2024-01-01", feeBps: 0 });
    assert.equal(r.strategy.trades, 1);
    // Signal on the 12:00 candle's close (200), bought at 13:00's open (200), held flat.
    near(r.strategy.return, 0, 1e-6);
    assert.equal(r.recent[0].in, "2024-01-03 13:00");
  });

  test("the same rules on 1-minute candles get in within a minute", () => {
    const { spec } = rules({ timeframe: "1m", entry: [up] });
    const r = backtest(spec, feed, { from: "2024-01-01", feeBps: 0 });
    assert.equal(r.recent[0].in, "2024-01-03 12:01");
  });

  test("gives the same result as running on pre-built hourly candles", () => {
    const wavy = Array.from({ length: 3 * 1440 }, (_, i) => 100 + 20 * Math.sin(i / 97) + (i % 7));
    const f = minuteFeed(minutes(wavy));
    const { spec } = rules({ timeframe: "1h", entry: [{ left: { kind: "price" }, op: "above", right: { kind: "sma", period: 5 } }], stop_loss_pct: 5 });
    const a = backtest(spec, f, { from: "2024-01-01", feeBps: 10 });
    const hr = f.frame("1h");
    const b = backtest(spec, { frame: (tf) => (tf === "1h" ? hr : null) }, { from: "2024-01-01", feeBps: 10 });
    near(a.strategy.return, b.strategy.return, 1e-12);
    assert.equal(a.strategy.trades, b.strategy.trades);
  });

  test("a mixed-timeframe cross runs, and says so when a timeframe has no prices", () => {
    const { spec } = rules({
      timeframe: "1m",
      entry: [{ left: { kind: "ema", period: 30, tf: "1m" }, op: "crosses_above", right: { kind: "sma", period: 2, tf: "1d" } }],
    });
    const r = backtest(spec, feed, { from: "2024-01-01", feeBps: 0 });
    assert.equal(typeof r.strategy.return, "number");
    const dailyOnly = { frame: (tf) => (tf === "1d" ? feed.frame("1d") : null) };
    assert.throws(() => backtest(spec, dailyOnly, { from: "2024-01-01" }), /1m prices/);
  });

  test("keeps the curve short however many candles it walks", () => {
    const { spec } = rules({ timeframe: "1m", entry: [up] });
    const r = backtest(spec, feed, { from: "2024-01-01", feeBps: 0 });
    assert.ok(r.curve.length <= 10, `curve has ${r.curve.length} points`);
  });
});

describe("the minute-price files", () => {
  test("reads a coin's minutes back, and returns null for a coin it doesn't have", () => {
    const dir = mkdtempSync(join(tmpdir(), "reins-min-"));
    const m = minutes([1, 2, 3, 4]);
    writeFileSync(join(dir, "BTC-1m.json"), JSON.stringify({ start: m.start, n: 4 }));
    writeFileSync(join(dir, "BTC-1m.bin"), Buffer.concat([m.o, m.h, m.l, m.c].map((a) => Buffer.from(a.buffer))));
    const r = readMinutes(dir, "BTC");
    assert.equal(r.start, T0);
    assert.deepEqual(Array.from(r.c), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(r.h), [1, 2, 3, 4]);
    assert.equal(readMinutes(dir, "ETH"), null);
  });
});
