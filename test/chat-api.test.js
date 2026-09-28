/**
 * The strategy chat over HTTP: status, a chat turn with its backtest, the
 * backtest endpoint, the limits that protect the shared free model keys, and
 * the OpenAI-compatible client. A fake model stands in for the real one.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app/server.js";
import { createLimiter } from "../app/strategy/routes.js";
import { createLlm } from "../app/strategy/llm.js";
import { minuteFeed } from "../app/strategy/candles.js";

const deployment = {
  network: "testnet",
  chainId: 5042002,
  contracts: { mandateFactory: "0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82" },
  external: { usdc: "0x3600000000000000000000000000000000000000" },
};

const trend = { type: "rules", name: "BTC 200-day trend", asset: "BTC", entry: [{ left: { kind: "price" }, op: "above", right: { kind: "sma", period: 200 } }] };

function fakeModel() {
  const m = { connected: true, name: "fake/model", lastRoute: null, calls: 0, next: null };
  m.complete = async () => { m.calls += 1; return m.next ?? JSON.stringify({ reply: "Built a BTC trend filter.", spec: trend }); };
  return m;
}

async function start(strategy) {
  const app = createApp({ deployment, strategy });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const post = async (base, path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const say = (text) => ({ messages: [{ role: "user", content: text }], spec: null });

describe("the chat endpoints", () => {
  let s, model;
  before(async () => {
    model = fakeModel();
    s = await start({
      llm: model,
      // Five chat turns reach the handler below (malformed requests are refused before they count).
      perVisitor: createLimiter({ max: 5, windowMs: 60_000 }),
      modelBudget: createLimiter({ max: 3, windowMs: 60_000 }),
    });
  });
  after(() => s?.server.close());

  test("status names the connected model and what it can trade", async () => {
    const r = await (await fetch(`${s.base}/api/chat/status`)).json();
    assert.equal(r.model, "fake/model");
    assert.ok(r.assets.includes("BTC"));
    assert.deepEqual(r.ranges, ["2019-01-01", "2021-01-01", "2024-01-01"]);
  });

  test("a chat turn returns the reply, the spec in words, and a backtest on real prices", async () => {
    const r = await post(s.base, "/api/chat", say("trend filter on bitcoin"));
    assert.equal(r.status, 200);
    assert.equal(r.body.reply, "Built a BTC trend filter.");
    assert.equal(r.body.spec.asset, "BTC");
    assert.equal(r.body.words[0], "Buy BTC when the price is above the 200-day average.");
    assert.equal(r.body.backtest.from, "2021-01-01");
    assert.equal(typeof r.body.backtest.strategy.return, "number");
    assert.ok(r.body.backtest.curve.length > 100);
  });

  test("says so when the strategy the page sent back is no longer valid", async () => {
    const r = await post(s.base, "/api/chat", { messages: [{ role: "user", content: "hi" }], spec: { ...trend, asset: "PEPE" } });
    assert.equal(r.body.specReset, true);
  });

  test("refuses a malformed conversation", async () => {
    assert.equal((await post(s.base, "/api/chat", { messages: "hi" })).status, 400);
    assert.equal((await post(s.base, "/api/chat", { messages: [] })).status, 400);
  });

  test("past the shared model budget it answers from the offline builder", async () => {
    // The budget above is 3 model calls; earlier tests used 2, so at most one more reaches the model.
    await post(s.base, "/api/chat", say("x"));
    await post(s.base, "/api/chat", say("x"));
    const before = model.calls;
    const r = await post(s.base, "/api/chat", say("golden cross on ETH"));
    assert.equal(model.calls, before);
    assert.equal(r.body.source, "offline");
    assert.equal(r.body.spec.asset, "ETH");
  });

  test("past the per-visitor limit it says to wait", async () => {
    const r = await post(s.base, "/api/chat", say("again"));
    assert.equal(r.status, 429);
    assert.match(r.body.error, /few minutes/);
  });
});

describe("the backtest endpoint", () => {
  let s;
  before(async () => { s = await start({ llm: fakeModel() }); });
  after(() => s?.server.close());

  test("backtests a valid spec over the chosen range", async () => {
    const r = await post(s.base, "/api/backtest", { spec: trend, from: "2024-01-01" });
    assert.equal(r.status, 200);
    assert.equal(r.body.backtest.from, "2024-01-01");
    assert.ok(r.body.backtest.hold.return > -1);
  });

  test("falls back to the default range for one it doesn't offer", async () => {
    const r = await post(s.base, "/api/backtest", { spec: trend, from: "1999-01-01" });
    assert.equal(r.body.backtest.from, "2021-01-01");
  });

  test("charges the fee you pick, and 0.1% for any it doesn't offer", async () => {
    const cheap = await post(s.base, "/api/backtest", { spec: trend, fee: 5 });
    const dear = await post(s.base, "/api/backtest", { spec: trend, fee: 30 });
    const odd = await post(s.base, "/api/backtest", { spec: trend, fee: 999 });
    assert.equal(cheap.body.backtest.feeBps, 5);
    assert.equal(odd.body.backtest.feeBps, 10);
    assert.ok(dear.body.backtest.strategy.feesPaid > cheap.body.backtest.strategy.feesPaid);
  });

  test("refuses an invalid spec with the reason", async () => {
    const r = await post(s.base, "/api/backtest", { spec: { ...trend, asset: "PEPE" } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /asset/);
  });
});

describe("strategies shorter than a day", () => {
  const hourly = { ...trend, name: "BTC hourly trend", timeframe: "1h", entry: [{ left: { kind: "price" }, op: "above", right: { kind: "ema", period: 20 } }] };
  // Ten days of minutes, rising: enough for a 20-hour EMA.
  const T0 = Date.UTC(2024, 0, 1) / 1000, n = 10 * 1440;
  const c = Float32Array.from({ length: n }, (_, i) => 100 + i / 100);
  const fakeMinutes = { has: (a) => a === "BTC", feed: (a) => (a === "BTC" ? minuteFeed({ start: T0, o: c, h: c, l: c, c }) : null) };

  test("run on minute prices when the server has them", async () => {
    const s = await start({ llm: fakeModel(), minutes: fakeMinutes });
    try {
      const r = await post(s.base, "/api/backtest", { spec: hourly, from: "2024-01-01" });
      assert.equal(r.status, 200);
      assert.equal(r.body.backtest.timeframe, "1h");
      assert.match(r.body.words.at(-1), /every hour/);
      const st = await (await fetch(`${s.base}/api/chat/status`)).json();
      assert.deepEqual(st.intraday, ["BTC"]);
    } finally { s.server.close(); }
  });

  test("say plainly when a coin's minute prices aren't on this server", async () => {
    const s = await start({ llm: fakeModel(), minutes: fakeMinutes });
    try {
      const r = await post(s.base, "/api/backtest", { spec: { ...hourly, asset: "ETH" } });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /minute prices for ETH/);
      // In the chat, the reply says so instead of failing the turn.
      const model = fakeModel();
      model.next = JSON.stringify({ reply: "Here's an hourly ETH trend.", spec: { ...hourly, asset: "ETH" } });
      const s2 = await start({ llm: model, minutes: fakeMinutes });
      try {
        const chat = await post(s2.base, "/api/chat", say("hourly eth trend"));
        assert.equal(chat.status, 200);
        assert.equal(chat.body.spec, null);
        assert.match(chat.body.reply, /minute prices for ETH/);
      } finally { s2.server.close(); }
    } finally { s.server.close(); }
  });
});

describe("without a model", () => {
  let s;
  before(async () => { s = await start({ llm: createLlm({ baseUrl: "" }) }); });
  after(() => s?.server.close());

  test("status says so, and the chat still builds strategies offline", async () => {
    assert.equal((await (await fetch(`${s.base}/api/chat/status`)).json()).model, null);
    const r = await post(s.base, "/api/chat", say("DCA into SOL every week"));
    assert.equal(r.body.source, "offline");
    assert.equal(r.body.spec.type, "dca");
    assert.equal(r.body.backtest.dca.buys > 50, true);
  });
});

describe("the OpenAI-compatible client", () => {
  const reply = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: new Headers(headers) });

  test("posts to /chat/completions with the key, asks for JSON, and reads the route header", async () => {
    const seen = [];
    const llm = createLlm({
      baseUrl: "http://127.0.0.1:3001/v1/", apiKey: "k", model: "auto",
      fetchImpl: async (url, init) => { seen.push({ url, init }); return reply(200, { choices: [{ message: { content: "{}" } }] }, { "x-routed-via": "groq/llama" }); },
    });
    assert.deepEqual(await llm.complete([{ role: "user", content: "hi" }]), { text: "{}", route: "groq/llama", usage: null });
    assert.equal(seen[0].url, "http://127.0.0.1:3001/v1/chat/completions");
    assert.equal(seen[0].init.headers.authorization, "Bearer k");
    assert.deepEqual(JSON.parse(seen[0].init.body).response_format, { type: "json_object" });
  });

  test("asks again without JSON mode when a provider rejects it", async () => {
    const bodies = [];
    const llm = createLlm({
      baseUrl: "http://x/v1",
      fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? reply(400, {}) : reply(200, { choices: [{ message: { content: "ok" } }] }); },
    });
    assert.equal((await llm.complete([])).text, "ok");
    assert.equal(bodies[1].response_format, undefined);
  });

  test("throws on errors and on silence, so the chat can fall back", async () => {
    await assert.rejects(createLlm({ baseUrl: "http://x/v1", fetchImpl: async () => reply(429, {}) }).complete([]), /429/);
    await assert.rejects(createLlm({ baseUrl: "http://x/v1", fetchImpl: async () => reply(200, { choices: [] }) }).complete([]), /no text/);
    await assert.rejects(createLlm({ baseUrl: "" }).complete([]), /no model/);
  });

  test("gives up on a slow endpoint", async () => {
    const llm = createLlm({
      baseUrl: "http://x/v1", timeoutMs: 20,
      fetchImpl: (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    await assert.rejects(llm.complete([]), /aborted/);
  });
});

describe("the limiter", () => {
  test("counts hits in a sliding window, per key", () => {
    let t = 0;
    const l = createLimiter({ max: 2, windowMs: 100, now: () => t });
    assert.equal(l.take("a"), true);
    assert.equal(l.take("a"), true);
    assert.equal(l.take("a"), false);
    assert.equal(l.take("b"), true);
    t = 150;
    assert.equal(l.take("a"), true);
  });
});
