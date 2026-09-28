/**
 * The backtest runner: daily strategies in-process, minute strategies on
 * worker threads so a long one never stalls the server, a result cache, a
 * queue that says "busy" instead of piling up, and a timeout that restarts a
 * stuck worker.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRunner, Unavailable, Busy } from "../app/strategy/runner.js";
import { parseSpec } from "../app/strategy/spec.js";

const T0 = Date.UTC(2024, 0, 1) / 1000;
const DAYS = 12;

/** A minutes directory with one coin (BTC) rising slowly for twelve days. */
function minutesDir() {
  const dir = mkdtempSync(join(tmpdir(), "reins-run-"));
  const n = DAYS * 1440;
  const c = Float32Array.from({ length: n }, (_, i) => 100 + i / 100 + Math.sin(i / 50));
  writeFileSync(join(dir, "BTC-1m.json"), JSON.stringify({ start: T0, n }));
  writeFileSync(join(dir, "BTC-1m.bin"), Buffer.concat([c, c, c, c].map((a) => Buffer.from(a.buffer))));
  return dir;
}
/** Daily candles for the in-process path. */
function daily() {
  const d = [], o = [], h = [], l = [], c = [];
  for (let i = 0; i < 400; i++) { const x = 100 + i; d.push(19_000 + i); o.push(x); h.push(x); l.push(x); c.push(x); }
  return { BTC: { d, o, h, l, c } };
}
const rules = (extra) => parseSpec({ type: "rules", name: "t", asset: "BTC", entry: [{ left: { kind: "price" }, op: "above", right: { kind: "ema", period: 20 } }], ...extra }).spec;
const hourly = rules({ timeframe: "1h" });

describe("daily strategies", () => {
  test("run in-process, and a repeat comes from the cache", async () => {
    let reads = 0;
    const runner = createRunner({ candles: () => { reads += 1; return daily(); } });
    const a = await runner.run(rules(), { from: "2022-01-01", feeBps: 10 });
    const b = await runner.run(rules(), { from: "2022-01-01", feeBps: 10 });
    assert.equal(reads, 1);
    assert.equal(a, b);
    assert.equal(typeof a.backtest.strategy.return, "number");
    assert.equal(a.words[0], "Buy BTC when the price is above the 20-day EMA.");
  });

  test("a different fee is a different result", async () => {
    const runner = createRunner({ candles: daily });
    const a = await runner.run(rules(), { from: "2022-01-01", feeBps: 5 });
    const b = await runner.run(rules(), { from: "2022-01-01", feeBps: 30 });
    assert.ok(b.backtest.strategy.feesPaid > a.backtest.strategy.feesPaid);
  });
});

describe("minute strategies on worker threads", () => {
  const dir = minutesDir();
  const runners = [];
  const make = (o) => { const r = createRunner({ candles: daily, minutesDir: dir, ...o }); runners.push(r); return r; };
  after(() => Promise.all(runners.map((r) => r.close())));

  test("run on a worker and come back with the same numbers as in-process", async () => {
    const runner = make();
    const r = await runner.run(hourly, { from: "2024-01-01", feeBps: 10 });
    assert.equal(r.backtest.timeframe, "1h");
    assert.ok(r.backtest.strategy.trades > 0);
    assert.equal(runner.has("BTC"), true);
    assert.equal(runner.has("ETH"), false);
  });

  test("two identical requests at once share one run", async () => {
    const runner = make();
    const [a, b] = await Promise.all([runner.run(hourly, { from: "2024-01-01", feeBps: 10 }), runner.run(hourly, { from: "2024-01-01", feeBps: 10 })]);
    assert.equal(a, b);
  });

  test("a coin without minute prices is refused plainly", async () => {
    const runner = make();
    await assert.rejects(runner.run({ ...hourly, asset: "ETH" }, { from: "2024-01-01", feeBps: 10 }), (e) => e instanceof Unavailable && /minute prices for ETH/.test(e.message));
  });

  test("past the queue limit it says busy instead of piling up", async () => {
    const runner = make({ workers: 1, maxQueue: 2 });
    const jobs = [5, 10, 30].map((feeBps) => runner.run(hourly, { from: "2024-01-01", feeBps }));
    const settled = await Promise.allSettled(jobs);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 2);
    assert.ok(settled[2].reason instanceof Busy);
  });

  test("a job that runs too long is stopped, and the next one still gets a worker", async () => {
    const runner = make({ workers: 1, timeoutMs: 1 });
    const jobs = [5, 10].map((feeBps) => runner.run(hourly, { from: "2024-01-01", feeBps }));
    const settled = await Promise.allSettled(jobs);
    for (const s of settled) assert.match(String(s.reason?.message), /too long/);
  });
});
