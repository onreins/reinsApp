/**
 * The strategy chat's pieces: the spec schema, the indicators, the
 * backtester, the offline builder, and the model conversation (with a fake
 * model, so no network and no keys).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseSpec, describeSpec } from "../app/strategy/spec.js";
import { sma, ema, rsi, highestPrev, lowestPrev, backtest } from "../app/strategy/backtest.js";
import { offlineDraft, respond } from "../app/strategy/chat.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/** Candles from closes: open = previous close, high/low = the day's extremes. */
function candles(closes, { startDay = 18628 } = {}) {
  const d = [], o = [], h = [], l = [], c = [];
  closes.forEach((x, i) => {
    const open = i ? closes[i - 1] : x;
    d.push(startDay + i); o.push(open); c.push(x);
    h.push(Math.max(open, x)); l.push(Math.min(open, x));
  });
  return { d, o, h, l, c };
}
const iso = (day) => new Date(day * 864e5).toISOString().slice(0, 10);

const priceAboveSma = (n) => ({ left: { kind: "price" }, op: "above", right: { kind: "sma", period: n } });

describe("the spec schema", () => {
  test("accepts a rules spec and fills in the defaults", () => {
    const r = parseSpec({ type: "rules", name: "BTC trend", asset: "BTC", entry: [priceAboveSma(200)] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.spec.exit, []);
    assert.equal(r.spec.position_pct, 100);
  });

  test("refuses an asset we have no prices for", () => {
    const r = parseSpec({ type: "rules", name: "x", asset: "PEPE", entry: [priceAboveSma(20)] });
    assert.equal(r.ok, false);
    assert.match(r.error, /asset/);
  });

  test("refuses fields nobody defined, so a model can't smuggle anything in", () => {
    const r = parseSpec({ type: "rules", name: "x", asset: "BTC", entry: [priceAboveSma(20)], leverage: 10 });
    assert.equal(r.ok, false);
  });

  test("refuses comparing RSI with a price", () => {
    const r = parseSpec({ type: "rules", name: "x", asset: "BTC", entry: [{ left: { kind: "rsi", period: 14 }, op: "below", right: { kind: "price" } }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /RSI/);
  });

  test("refuses out-of-range numbers", () => {
    assert.equal(parseSpec({ type: "rules", name: "x", asset: "BTC", entry: [priceAboveSma(1)] }).ok, false);
    assert.equal(parseSpec({ type: "rules", name: "x", asset: "BTC", entry: [priceAboveSma(20)], stop_loss_pct: 90 }).ok, false);
    assert.equal(parseSpec({ type: "dca", name: "x", asset: "BTC", every_days: 0 }).ok, false);
  });

  test("describes a spec in plain words", () => {
    const { spec } = parseSpec({ type: "rules", name: "x", asset: "ETH", entry: [priceAboveSma(200)], stop_loss_pct: 10 });
    assert.deepEqual(describeSpec(spec), [
      "Buy ETH when the price is above the 200-day average.",
      "Sell when that stops being true.",
      "Stop-loss 10% below the entry.",
    ]);
  });
});

describe("indicators", () => {
  test("SMA is the mean of the last n closes, undefined before that", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    assert.ok(Number.isNaN(s[1]));
    near(s[2], 2); near(s[4], 4);
  });

  test("EMA is seeded with the SMA, then weights 2/(n+1)", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    near(e[2], 2);
    near(e[3], 2 + 0.5 * (4 - 2));
  });

  test("RSI is 100 when a series only rises and 0 when it only falls", () => {
    near(rsi([1, 2, 3, 4, 5, 6, 7], 3)[6], 100);
    near(rsi([7, 6, 5, 4, 3, 2, 1], 3)[6], 0);
  });

  test("the n-day high and low leave today out, so a breakout can happen", () => {
    const h = highestPrev([1, 5, 3, 9, 2], 2);
    assert.ok(Number.isNaN(h[1]));
    assert.equal(h[2], 5); assert.equal(h[4], 9);
    assert.equal(lowestPrev([4, 2, 3, 1, 5], 2)[4], 1);
  });
});

describe("the backtester", () => {
  const rules = (entry, extra = {}) => parseSpec({ type: "rules", name: "t", asset: "BTC", entry, ...extra }).spec;

  test("acts on the close's signal at the next open, and pays the fee both ways", () => {
    // Flat, then a step up: the signal fires on the step's close, the buy fills at the next open.
    const k = candles([10, 10, 10, 10, 20, 20, 20, 20]);
    const r = backtest(rules([{ left: { kind: "price" }, op: "above", right: { kind: "value", value: 15 } }]), k, { from: iso(k.d[0]), feeBps: 10 });
    assert.equal(r.strategy.trades, 1);
    // Bought at 20 (the open after the jump) and held flat: the only change is the entry fee.
    near(r.strategy.return, 1 / 1.001 - 1, 1e-9);
    // Holding from the first open doubled, less the same entry fee.
    near(r.hold.return, 2 / 1.001 - 1, 1e-9);
  });

  test("leaves when the entry stops holding if there are no exit rules", () => {
    const k = candles([10, 10, 20, 20, 5, 5, 5]);
    const r = backtest(rules([{ left: { kind: "price" }, op: "above", right: { kind: "value", value: 15 } }]), k, { from: iso(k.d[0]), feeBps: 0 });
    assert.equal(r.strategy.trades, 1);
    assert.equal(r.recent[0].open, false);
    // In at 20 (next open after the close at 20), out at the open after the close at 5, which is 5.
    near(r.recent[0].ret, 5 / 20 - 1);
  });

  test("a stop-loss fills at the stop, or at the open when the price gapped through it", () => {
    const up = { left: { kind: "price" }, op: "above", right: { kind: "value", value: 15 } };
    // Enter at 20; the next day trades down to 17 intraday: a 10% stop fills at 18.
    const k1 = { d: [1, 2, 3, 4, 5], o: [10, 10, 20, 20, 19], h: [10, 20, 20, 20, 19], l: [10, 10, 20, 17, 18], c: [10, 20, 20, 19, 19] };
    const r1 = backtest(rules([up], { stop_loss_pct: 10 }), k1, { from: iso(1), feeBps: 0 });
    near(r1.recent[0].ret, -0.1);
    // Same, but the day opens at 16, under the stop: it fills at 16.
    const k2 = { d: [1, 2, 3, 4, 5], o: [10, 10, 20, 16, 16], h: [10, 20, 20, 16, 16], l: [10, 10, 20, 15, 16], c: [10, 20, 20, 16, 16] };
    const r2 = backtest(rules([up], { stop_loss_pct: 10 }), k2, { from: iso(1), feeBps: 0 });
    near(r2.recent[0].ret, 16 / 20 - 1);
  });

  test("after a stop-out it waits for the entry to reset before buying again", () => {
    const up = { left: { kind: "price" }, op: "above", right: { kind: "value", value: 15 } };
    const k = { d: [1, 2, 3, 4, 5, 6], o: [10, 10, 20, 20, 17, 17], h: [10, 20, 20, 20, 17, 17], l: [10, 10, 20, 17, 17, 17], c: [10, 20, 20, 17, 17, 17] };
    const r = backtest(rules([up], { stop_loss_pct: 10 }), k, { from: iso(1), feeBps: 0 });
    assert.equal(r.strategy.trades, 1);
  });

  test("DCA buys a fixed amount on schedule and reports value against what went in", () => {
    const k = candles([10, 10, 10, 10, 20, 20, 20, 20]);
    const spec = parseSpec({ type: "dca", name: "d", asset: "BTC", every_days: 2 }).spec;
    const r = backtest(spec, k, { from: iso(k.d[0]), feeBps: 0 });
    // Buys at the opens of days 0, 2, 4, 6: 10, 10, 10 (the open after the close at 10), 20.
    assert.equal(r.dca.buys, 4);
    near(r.dca.invested, 4);
    const units = 1 / 10 + 1 / 10 + 1 / 10 + 1 / 20;
    near(r.dca.value, units * 20);
  });

  test("warms indicators up on the days before the chosen start", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const k = candles(closes);
    const r = backtest(rules([priceAboveSma(30)]), k, { from: iso(k.d[40]), feeBps: 0 });
    // The 30-day average already exists on the first day, so it's invested from the first open.
    assert.equal(r.strategy.exposure > 0.9, true);
  });

  test("refuses a start after the last day it has", () => {
    const k = candles([1, 2, 3]);
    assert.throws(() => backtest(rules([priceAboveSma(2)]), k, { from: "2099-01-01" }), /no prices/);
  });
});

describe("the offline builder", () => {
  test("reads a 200-day trend filter", () => {
    const r = offlineDraft("Buy ETH when it's above its 200 day moving average");
    assert.equal(r.spec.asset, "ETH");
    assert.deepEqual(r.spec.entry, [priceAboveSma(200)]);
  });

  test("reads a golden cross with a stop", () => {
    const r = offlineDraft("golden cross on BTC with a 10% stop loss");
    assert.equal(r.spec.entry[0].op, "crosses_above");
    assert.equal(r.spec.exit[0].op, "crosses_below");
    assert.equal(r.spec.stop_loss_pct, 10);
  });

  test("reads RSI oversold, a breakout and DCA", () => {
    assert.equal(offlineDraft("buy SOL when RSI is oversold").spec.entry[0].left.kind, "rsi");
    assert.equal(offlineDraft("breakout above the 20 day high on LINK").spec.entry[0].right.kind, "highest");
    const d = offlineDraft("dca into bitcoin every week");
    assert.equal(d.spec.type, "dca");
    assert.equal(d.spec.every_days, 7);
  });

  test("changes the current strategy's asset or stop when that's all you ask", () => {
    const base = offlineDraft("golden cross on BTC").spec;
    const r = offlineDraft("switch to ETH and add a 15% stop", base);
    assert.equal(r.spec.asset, "ETH");
    assert.equal(r.spec.stop_loss_pct, 15);
  });

  test("never reads a percentage as a period", () => {
    const r = offlineDraft("Buy BTC above its average with a 10% stop");
    assert.deepEqual(r.spec.entry, [priceAboveSma(200)]);
    assert.equal(r.spec.stop_loss_pct, 10);
  });

  test("a sell-only instruction changes the exit and keeps the entry", () => {
    const base = offlineDraft("golden cross on BTC").spec;
    const r = offlineDraft("Sell BTC when RSI is above 80", base);
    assert.deepEqual(r.spec.entry, base.entry);
    assert.deepEqual(r.spec.exit, [{ left: { kind: "rsi", period: 14 }, op: "above", right: { kind: "value", value: 80 } }]);
    // With nothing to sell yet, it asks for the buy side first.
    assert.equal(offlineDraft("sell when RSI is above 80").spec, null);
  });

  test("says what it can do when it can't read the idea", () => {
    const r = offlineDraft("what's the weather like");
    assert.equal(r.spec, null);
    assert.match(r.reply, /200-day|golden cross|RSI/);
    assert.ok(r.options.length >= 3);
  });

  test("never repeats the same fallback twice in a row", () => {
    const first = offlineDraft("what's the weather like");
    const second = offlineDraft("and tomorrow?", null, { previous: first.reply });
    assert.notEqual(second.reply, first.reply);
  });

  test("answers a greeting with ideas to tap, not the help text", () => {
    const r = offlineDraft("ho");
    assert.equal(r.spec, null);
    assert.match(r.reply, /^Hi/);
    assert.ok(r.options.length >= 3);
  });

  test("lists ideas when asked for suggestions", () => {
    const r = offlineDraft("do u have suggestions of strategys");
    assert.equal(r.spec, null);
    assert.match(r.reply, /Trend filter/);
    assert.match(r.reply, /DCA/);
    assert.ok(r.options.every((o) => offlineDraft(o).spec), "every suggested idea builds");
  });

  test("explains that a pair trade isn't possible and offers each coin on its own", () => {
    const r = offlineDraft("what abt a buy btc sell eth strategy");
    assert.equal(r.spec, null);
    assert.match(r.reply, /one coin/);
    assert.ok(r.options.some((o) => /BTC/.test(o)) && r.options.some((o) => /ETH/.test(o)));
  });

  test("explains that shorting isn't possible", () => {
    assert.match(offlineDraft("short ETH with 5x leverage").reply, /spot/);
  });

  test("asks what should trigger a buy when it only hears a coin", () => {
    const r = offlineDraft("what about doge");
    assert.match(r.reply, /DOGE/);
    assert.ok(r.options.every((o) => /DOGE/.test(o) && offlineDraft(o).spec));
  });

  test("describes the current strategy when asked about it", () => {
    const base = offlineDraft("golden cross on BTC").spec;
    const r = offlineDraft("how does it work?", base);
    assert.equal(r.spec, null);
    assert.match(r.reply, /50-day average crosses above/);
  });
});

describe("talking to the model", () => {
  const fakeModel = (answers) => {
    const calls = [];
    return {
      connected: true, name: "fake/model", calls,
      complete: async (messages) => { calls.push(messages); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
    };
  };
  const userSays = (text) => [{ role: "user", content: text }];
  const goodSpec = { type: "rules", name: "BTC trend", asset: "BTC", entry: [priceAboveSma(200)] };

  test("returns the model's reply and a validated spec", async () => {
    const llm = fakeModel([JSON.stringify({ reply: "Here it is.", spec: goodSpec })]);
    const r = await respond({ messages: userSays("trend on btc"), spec: null, llm });
    assert.equal(r.reply, "Here it is.");
    assert.equal(r.spec.asset, "BTC");
    assert.equal(r.source, "fake/model");
  });

  test("gives the model one chance to fix a spec the schema refused", async () => {
    const llm = fakeModel([
      JSON.stringify({ reply: "x", spec: { ...goodSpec, asset: "PEPE" } }),
      JSON.stringify({ reply: "Fixed.", spec: goodSpec }),
    ]);
    const r = await respond({ messages: userSays("trend"), spec: null, llm });
    assert.equal(r.spec.asset, "BTC");
    assert.equal(llm.calls.length, 2);
    assert.match(llm.calls[1].at(-1).content, /asset/);
  });

  test("reads JSON even when the model wraps it in prose or a code fence", async () => {
    const llm = fakeModel(["Sure!\n```json\n" + JSON.stringify({ reply: "Done.", spec: goodSpec }) + "\n```"]);
    const r = await respond({ messages: userSays("trend"), spec: null, llm });
    assert.equal(r.spec.asset, "BTC");
  });

  test("falls back to the offline builder when the model fails", async () => {
    const llm = fakeModel([new Error("429 from every provider")]);
    const r = await respond({ messages: userSays("golden cross on ETH"), spec: null, llm });
    assert.equal(r.source, "offline");
    assert.equal(r.spec.asset, "ETH");
  });

  test("never passes on a spec that is still invalid after the retry", async () => {
    const bad = JSON.stringify({ reply: "x", spec: { ...goodSpec, leverage: 50 } });
    const llm = fakeModel([bad, bad]);
    const r = await respond({ messages: userSays("100x btc"), spec: null, llm });
    assert.equal(r.spec, null);
  });

  test("two chats at once each report the model that answered them", async () => {
    // The first call answers last, so a shared "last route" would mix the two up.
    let n = 0;
    const llm = {
      connected: true, name: "auto",
      complete: (msgs) => new Promise((resolve) => {
        const mine = ++n === 1 ? "groq/a" : "cloudflare/b";
        setTimeout(() => resolve({ text: JSON.stringify({ reply: mine, spec: null }), route: mine }), mine === "groq/a" ? 30 : 5);
      }),
    };
    const [a, b] = await Promise.all([respond({ messages: userSays("one"), spec: null, llm }), respond({ messages: userSays("two"), spec: null, llm })]);
    assert.equal(a.source, "groq/a");
    assert.equal(b.source, "cloudflare/b");
  });

  test("caps what it sends: the last few turns, each trimmed", async () => {
    const llm = fakeModel([JSON.stringify({ reply: "ok", spec: null })]);
    const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(5000) }));
    await respond({ messages: long, spec: null, llm });
    const sent = llm.calls[0].filter((m) => m.role !== "system");
    assert.ok(sent.length <= 10);
    assert.ok(sent.every((m) => m.content.length <= 1500));
  });
});
