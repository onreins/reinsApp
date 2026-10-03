// The Charts page's numbers: each exchange's 24-hour stats turned into one
// list of markets, the list's search and sort, and the sample thesis.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL("../app/public/markets.js", import.meta.url), "utf8"), ctx);
const M = ctx.window.ReinsMarkets;

const bn = (symbol, open, last, quoteVolume, extra = {}) => ({
  symbol, openPrice: String(open), lastPrice: String(last), highPrice: String(Math.max(open, last) * 1.01), lowPrice: String(Math.min(open, last) * 0.99),
  quoteVolume: String(quoteVolume), count: 100, ...extra,
});

describe("reading the exchanges", () => {
  test("Binance pairs split on their quote, with volume in dollars even for BTC-quoted pairs", () => {
    const rows = M.fromBinance([bn("BTCUSDT", 100000, 101000, 2e9), bn("ETHBTC", 0.03, 0.031, 100), bn("FDUSDUSDT", 1, 1, 5e8)]);
    const eth = rows.find((r) => r.id === "binance:ETHBTC");
    assert.equal(eth.base, "ETH");
    assert.equal(eth.quote, "BTC");
    assert.equal(Math.round(eth.volUsd), 100 * 101000, "100 BTC of volume at the BTC price");
    assert.ok(Math.abs(rows[0].change - 0.01) < 1e-12);
    assert.equal(rows.find((r) => r.id === "binance:FDUSDUSDT").quote, "USDT", "the longest quote wins: FDUSD/USDT, not FD/USDUSDT");
  });

  test("delisted Binance pairs, with no trades, are left out, and lira pairs price through USDTTRY", () => {
    const rows = M.fromBinance([bn("LUNAUSDT", 1, 1, 0, { count: 0 }), bn("USDTTRY", 40, 40, 1e6), bn("BTCTRY", 4e6, 4e6, 4e8)]);
    assert.equal(rows.find((r) => r.base === "LUNA"), undefined);
    assert.equal(Math.round(rows.find((r) => r.id === "binance:BTCTRY").volUsd), 1e7, "400M lira at 40 lira a dollar");
  });

  test("Coinbase stats become spot markets with volume in dollars", () => {
    const rows = M.fromCoinbase({
      "BTC-USD": { stats_24hour: { open: "100", high: "110", low: "95", last: "105", volume: "10" } },
      "ETH-BTC": { stats_24hour: { open: "0.03", high: "0.031", low: "0.029", last: "0.03", volume: "1000" } },
      "DEAD-USD": { stats_24hour: { open: "1", high: "1", low: "1", last: "1", volume: "0" } },
    });
    assert.equal(rows.map((r) => r.id).sort().join(), "coinbase:BTC-USD,coinbase:ETH-BTC");
    assert.equal(rows.find((r) => r.base === "BTC").volUsd, 1050);
    assert.equal(Math.round(rows.find((r) => r.base === "ETH").volUsd), 1000 * 0.03 * 105);
  });

  test("Hyperliquid perps carry funding and open interest, and skip delisted coins", () => {
    const rows = M.fromHyperliquid([
      { universe: [{ name: "BTC", maxLeverage: 40 }, { name: "MATIC", isDelisted: true }] },
      [{ markPx: "100", prevDayPx: "80", dayNtlVlm: "5e8", funding: "0.0001", openInterest: "10" }, { markPx: "1", prevDayPx: "1", dayNtlVlm: "1", funding: "0", openInterest: "1" }],
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "perp");
    assert.equal(rows[0].oiUsd, 1000);
    assert.equal(rows[0].change, 0.25);
    assert.equal(M.label(rows[0]), "BTC-PERP");
  });

  test("broken payloads give an empty list, not a crash", () => {
    assert.deepEqual([...M.fromBinance(null)], []);
    assert.deepEqual([...M.fromCoinbase(undefined)], []);
    assert.deepEqual([...M.fromHyperliquid({})], []);
  });
});

describe("the market list", () => {
  const rows = [
    { id: "binance:BTCUSDT", venue: "binance", base: "BTC", quote: "USDT", volUsd: 3e9, change: -0.01, last: 100000 },
    { id: "hyperliquid:ETH", venue: "hyperliquid", base: "ETH", quote: "USD", kind: "perp", volUsd: 2e9, change: 0.05, last: 3000 },
    { id: "coinbase:SOL-USD", venue: "coinbase", base: "SOL", quote: "USD", volUsd: null, change: 0.02, last: 150 },
    { id: "binance:USDCUSDT", venue: "binance", base: "USDC", quote: "USDT", volUsd: 9e9, change: 0, last: 1 },
  ];
  const ids = (list) => list.map((r) => r.id);

  test("sorts by volume by default, unknown volume last, and hides stablecoin pairs", () => {
    assert.deepEqual(ids(M.view(rows, {})), ["binance:BTCUSDT", "hyperliquid:ETH", "coinbase:SOL-USD"]);
  });
  test("searching finds a coin by name or pair, including a stablecoin pair asked for by name", () => {
    assert.deepEqual(ids(M.view(rows, { query: "eth" })), ["hyperliquid:ETH"]);
    assert.deepEqual(ids(M.view(rows, { query: "btc/usdt" })), ["binance:BTCUSDT"]);
    assert.deepEqual(ids(M.view(rows, { query: "usdc" })), ["binance:USDCUSDT"]);
  });
  test("filters by exchange or by starred markets, and sorts by the day's move either way", () => {
    assert.deepEqual(ids(M.view(rows, { venue: "coinbase" })), ["coinbase:SOL-USD"]);
    assert.deepEqual(ids(M.view(rows, { venue: "fav", favs: { "hyperliquid:ETH": 1 } })), ["hyperliquid:ETH"]);
    assert.deepEqual(ids(M.view(rows, { sort: "change", dir: "asc" })), ["binance:BTCUSDT", "coinbase:SOL-USD", "hyperliquid:ETH"]);
  });
  test("sorting by name runs A to Z ascending and Z to A descending", () => {
    assert.equal(ids(M.view(rows, { sort: "name", dir: "asc" })).join(), "binance:BTCUSDT,hyperliquid:ETH,coinbase:SOL-USD");
    assert.equal(ids(M.view(rows, { sort: "name", dir: "desc" })).join(), "coinbase:SOL-USD,hyperliquid:ETH,binance:BTCUSDT");
  });
  test("finds the chart's market whatever its case", () => {
    assert.equal(M.find(rows, "HYPERLIQUID:ETH").base, "ETH");
    assert.equal(M.find(rows, "binance:NOPE"), null);
  });
});

describe("the sample thesis", () => {
  const market = (over) => ({ id: "binance:X", venue: "binance", kind: "spot", base: "X", quote: "USDT", last: 110, open: 100, high: 111, low: 99, change: 0.1, volUsd: 1e9, ...over });
  const crowd = Array.from({ length: 20 }, (_, i) => market({ id: "binance:C" + i, base: "C" + i, volUsd: 1e6 * (i + 1), change: 0 }));

  test("a busy coin up 10% near its high is hot, and says why", () => {
    const r = market();
    const t = M.thesis([...crowd, r], r);
    assert.equal(t.verdict, "hot");
    assert.equal(t.reads[0].stance, "bull");
    assert.equal(t.reads[1].stance, "bull");
    assert.match(M.reason(t), /At its highs · heavy volume/);
  });

  test("a thin coin falling to its low is cold", () => {
    const r = market({ last: 90, open: 100, high: 101, low: 89.5, change: -0.1, volUsd: 1 });
    assert.equal(M.thesis([...crowd, r], r).verdict, "cold");
  });

  test("perps paying heavy funding read as crowded", () => {
    const r = market({ id: "hyperliquid:X", venue: "hyperliquid", kind: "perp", high: null, low: null, change: 0, funding: 0.0001 });
    const flow = M.thesis([r], r).reads[1];
    assert.equal(flow.stance, "caution");
    assert.match(flow.text, /87\.6% a year/);
  });

  test("the loss limit leaves room for twice a day's swing, from 5% to 30%", () => {
    assert.equal(M.lossLimitFor(0.01), 5);
    assert.equal(M.lossLimitFor(0.04), 10);
    assert.equal(M.lossLimitFor(0.05), 10, "exactly 10% is not rounded up by float error");
    assert.equal(M.lossLimitFor(0.5), 30);
    assert.equal(M.lossLimitFor(null), 20);
  });

  test("the idea for the strategy chat names the coin and its rules", () => {
    const r = market();
    const t = M.thesis([...crowd, r], r);
    const idea = M.idea(r, t);
    assert.match(idea, /^Buy X /);
    assert.ok(idea.includes(t.rules.lossPercent + "%"));
    assert.ok(idea.includes(t.rules.tradePercent + "% of the deposit"));
  });

  test("the hot list shows each coin once, by its busiest market, and needs $5M traded", () => {
    const rows = [
      market({ id: "binance:AUSDT", base: "A", volUsd: 9e8, change: 0.2 }),
      market({ id: "coinbase:A-USD", venue: "coinbase", base: "A", volUsd: 1e8, change: 0.25 }),
      market({ id: "binance:BUSDT", base: "B", volUsd: 1e6, change: 0.3 }),
      market({ id: "binance:CUSDT", base: "C", volUsd: 5e8, change: -0.2, last: 80, open: 100, high: 101, low: 79 }),
    ];
    const { hot, cold } = M.hotList(rows, 1);
    assert.deepEqual(hot.map((x) => x.row.id), ["binance:AUSDT"]);
    assert.deepEqual(cold.map((x) => x.row.id), ["binance:CUSDT"]);
  });

  test("on a day with nothing hot, the hot list is empty rather than padded with cold coins", () => {
    const rows = ["A", "B", "C"].map((b) => market({ id: "binance:" + b + "USDT", base: b, volUsd: 5e8, change: -0.2, last: 80, open: 100, high: 101, low: 79 }));
    const { hot, cold } = M.hotList(rows, 8);
    assert.equal(hot.length, 0);
    assert.equal(cold.length, 3);
    assert.ok(cold.every((x) => x.thesis.score < 0));
  });
});

test("rounds start every four hours on the UTC clock", () => {
  const at = Date.UTC(2026, 9, 3, 9, 30);
  const rd = M.round(at);
  assert.equal(rd.start, Date.UTC(2026, 9, 3, 8, 0));
  assert.equal(rd.next, Date.UTC(2026, 9, 3, 12, 0));
  assert.equal(M.left(rd.left), "2h 30m");
});

test("prices keep sensible precision from bitcoin to meme coins", () => {
  assert.equal(M.price(84651.4712), "84,651.47");
  assert.equal(M.price(88.184), "88.1840");
  assert.equal(M.price(119.5611), "119.56");
  assert.equal(M.price(0.000012345), "0.00001235");
  assert.equal(M.money(3.22e9), "$3.22B");
  assert.equal(M.price(null), "–");
});
