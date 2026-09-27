/**
 * The bridge: any strategy "brain" (freqtrade running NostalgiaForInfinity,
 * TradingAgents, a person) sends signals; the bridge turns them into trades
 * inside a mandate, or records them as shadow trades when the asset isn't
 * tradable on Arc yet. The mandate still enforces every rule on-chain.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { createMandate, MandateClient } from "../mandate/sdk.js";
import { createRegistry, parsePair } from "../bridge/registry.js";
import { fromFreqtrade, fromDecision } from "../bridge/signals.js";
import { createExecutor } from "../bridge/executor.js";
import { memoryLedger, fileLedger } from "../bridge/ledger.js";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeApp } from "../bridge/server.js";

// ------------------------------------------------------------------ helpers
const registry = createRegistry({
  quotes: ["USD", "USDT", "USDC"],
  map: { EUR: "EURC", EURC: "EURC", BTC: "BTC", NVDA: "NVDAx" },
});

/** A stand-in MandateClient: a status to read, and trades it records or refuses. */
function fakeClient({ allowed = ["USDC", "EURC"], cash = 100, eurc = 0, eurPrice = 1.14, maxTradeUsd = 20, canTrade = true, refuse = null, landedWithoutConfirm = false, slow = 0 } = {}) {
  const trades = [];
  return {
    trades,
    async status() {
      return {
        canTrade,
        frozen: !canTrade,
        rules: { maxTradeUsd, allowedAssets: allowed },
        holdings: [
          { symbol: "USDC", amount: cash, valueUsd: cash },
          { symbol: "EURC", amount: eurc, valueUsd: eurPrice === null ? null : eurc * eurPrice },
        ],
      };
    },
    async trade(t) {
      if (slow) await new Promise((r) => setTimeout(r, slow));
      if (refuse) {
        const e = new Error("trade refused");
        e.mandate = refuse;
        throw e;
      }
      if (landedWithoutConfirm) {
        trades.push(t);
        const e = new Error("trade sent (0xfeed) but its receipt couldn't be read");
        e.hash = "0xfeed";
        throw e;
      }
      trades.push(t);
      return { hash: "0xabc", sold: { symbol: t.from, amount: Number(t.amount) }, bought: { symbol: t.to, amount: 1 } };
    },
  };
}

// ---------------------------------------------------------------- registry
describe("registry", () => {
  test("reads exchange pairs, including futures notation", () => {
    assert.deepEqual(parsePair("BTC/USDT"), { base: "BTC", quote: "USDT" });
    assert.deepEqual(parsePair("ETH/USDC:USDC"), { base: "ETH", quote: "USDC" });
    assert.deepEqual(parsePair("NVDA"), { base: "NVDA", quote: "USD" });
  });

  test("maps an outside symbol to the mandate's token, or says it has none", () => {
    assert.equal(registry.symbolFor("EUR"), "EURC");
    assert.equal(registry.symbolFor("NVDA"), "NVDAx");
    assert.equal(registry.symbolFor("DOGE"), null);
    assert.equal(registry.isQuote("USDT"), true);
    assert.equal(registry.isQuote("BTC"), false);
  });
});

// ----------------------------------------------------------------- signals
describe("signals", () => {
  test("a freqtrade entry becomes a buy sized by its stake", () => {
    const s = fromFreqtrade({ type: "entry_fill", trade_id: 7, pair: "EUR/USDT", direction: "long", stake_amount: "12.5", enter_tag: "dip" });
    assert.equal(s.side, "buy");
    assert.equal(s.asset, "EUR");
    assert.equal(s.sizeUsd, 12.5);
    assert.equal(s.id, "freqtrade:7:entry");
    assert.match(s.reason, /dip/);
  });

  test("a freqtrade exit sells the whole position", () => {
    const s = fromFreqtrade({ type: "exit_fill", trade_id: 7, pair: "EUR/USDT", exit_reason: "roi" });
    assert.equal(s.side, "sell");
    assert.equal(s.fraction, 1);
    assert.equal(s.id, "freqtrade:7:exit");
  });

  test("shorts are refused: a mandate is spot only", () => {
    const s = fromFreqtrade({ type: "entry", trade_id: 8, pair: "BTC/USDT", direction: "short", stake_amount: 10 });
    assert.equal(s.side, "none");
    assert.match(s.reason, /short/i);
  });

  test("cancels and status pings are ignored", () => {
    assert.equal(fromFreqtrade({ type: "entry_cancel", trade_id: 9, pair: "BTC/USDT" }), null);
    assert.equal(fromFreqtrade({ type: "status", status: "running" }), null);
  });

  test("a TradingAgents decision is read as buy, sell or hold", () => {
    assert.equal(fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "FINAL TRANSACTION PROPOSAL: **BUY**", sizeUsd: 5 }).side, "buy");
    assert.equal(fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "Sell" }).side, "sell");
    assert.equal(fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "HOLD for now" }).side, "hold");
    assert.equal(fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "no idea" }).side, "none");
  });

  test("the same decision sent twice without an id gets the same id, so a retry can't trade twice", () => {
    const a = fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "BUY", sizeUsd: 5 });
    const b = fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "BUY", sizeUsd: 5 });
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, fromDecision({ source: "tradingagents", ticker: "NVDA", decision: "SELL" }).id);
  });
});

// ---------------------------------------------------------------- executor
describe("executor", () => {
  test("an asset the mandate can't hold yet is recorded as a shadow trade", async () => {
    const client = fakeClient();
    const ledger = memoryLedger();
    const ex = createExecutor({ client, registry, ledger, mode: "live" });
    const r = await ex.handle(fromFreqtrade({ type: "entry_fill", trade_id: 1, pair: "BTC/USDT", stake_amount: 10 }));
    assert.equal(r.outcome, "shadow");
    assert.match(r.reason, /BTC/);
    assert.equal(client.trades.length, 0);
    assert.equal(ledger.all().length, 1);
  });

  test("a buy is capped at the mandate's per-trade limit", async () => {
    const client = fakeClient({ maxTradeUsd: 20 });
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const r = await ex.handle(fromFreqtrade({ type: "entry_fill", trade_id: 2, pair: "EUR/USDT", stake_amount: 50 }));
    assert.equal(r.outcome, "traded");
    assert.equal(r.clamped, true);
    assert.deepEqual(client.trades[0], { from: "USDC", to: "EURC", amount: "20" });
  });

  test("a sell takes the whole holding, capped by value", async () => {
    const client = fakeClient({ eurc: 30, eurPrice: 1.14, maxTradeUsd: 20 });
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const r = await ex.handle(fromFreqtrade({ type: "exit_fill", trade_id: 3, pair: "EUR/USDT" }));
    assert.equal(r.outcome, "traded");
    assert.equal(client.trades[0].from, "EURC");
    assert.equal(client.trades[0].to, "USDC");
    // $20 cap at $1.14 a euro is 17.543859 EURC, rounded down.
    assert.equal(client.trades[0].amount, "17.543859");
  });

  test("shadow mode records what it would do and trades nothing", async () => {
    const client = fakeClient();
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "shadow" });
    const r = await ex.handle(fromFreqtrade({ type: "entry_fill", trade_id: 4, pair: "EUR/USDT", stake_amount: 5 }));
    assert.equal(r.outcome, "shadow");
    assert.deepEqual(r.intended, { from: "USDC", to: "EURC", amount: "5" });
    assert.equal(client.trades.length, 0);
  });

  test("a retried webhook is not traded twice", async () => {
    const client = fakeClient();
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const signal = fromFreqtrade({ type: "entry_fill", trade_id: 5, pair: "EUR/USDT", stake_amount: 5 });
    await ex.handle(signal);
    const again = await ex.handle(signal);
    assert.equal(again.outcome, "duplicate");
    assert.equal(client.trades.length, 1);
  });

  test("a refusal on-chain is recorded with the rule that refused it", async () => {
    const client = fakeClient({ refuse: { rule: "PriceTooLow", reason: "the exchange offered a worse price" } });
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const r = await ex.handle(fromFreqtrade({ type: "entry_fill", trade_id: 6, pair: "EUR/USDT", stake_amount: 5 }));
    assert.equal(r.outcome, "refused");
    assert.equal(r.rule, "PriceTooLow");
  });

  test("a trade that was sent but not confirmed is recorded as unknown, with its hash, and never resent", async () => {
    const client = fakeClient({ landedWithoutConfirm: true });
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const signal = fromFreqtrade({ type: "entry_fill", trade_id: 11, pair: "EUR/USDT", stake_amount: 5 });
    const r = await ex.handle(signal);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.hash, "0xfeed");
    assert.equal((await ex.handle(signal)).outcome, "duplicate");
    assert.equal(client.trades.length, 1, "it was not resent");
  });

  test("dust too small to trade is skipped, not sent as a zero trade", async () => {
    const buy = createExecutor({ client: fakeClient({ cash: 0.0000004 }), registry, ledger: memoryLedger(), mode: "live" });
    assert.equal((await buy.handle(fromFreqtrade({ type: "entry_fill", trade_id: 12, pair: "EUR/USDT", stake_amount: 5 }))).outcome, "skipped");
    const client = fakeClient({ eurc: 0.0000004 });
    const sell = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    assert.equal((await sell.handle(fromFreqtrade({ type: "exit_fill", trade_id: 12, pair: "EUR/USDT" }))).outcome, "skipped");
    assert.equal(client.trades.length, 0);
  });

  test("a position it can't price is not sold blind", async () => {
    const client = fakeClient({ eurc: 50, eurPrice: null });
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const r = await ex.handle(fromFreqtrade({ type: "exit_fill", trade_id: 13, pair: "EUR/USDT" }));
    assert.equal(r.outcome, "skipped");
    assert.match(r.reason, /price/);
    assert.equal(client.trades.length, 0);
  });

  test("two identical signals at once trade once", async () => {
    const client = fakeClient({ slow: 30 });
    const ex = createExecutor({ client, registry, ledger: memoryLedger(), mode: "live" });
    const signal = fromFreqtrade({ type: "entry_fill", trade_id: 14, pair: "EUR/USDT", stake_amount: 5 });
    const outcomes = (await Promise.all([ex.handle(signal), ex.handle(signal)])).map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ["duplicate", "traded"]);
    assert.equal(client.trades.length, 1);
  });

  test("a frozen mandate is skipped, and a hold does nothing", async () => {
    const frozen = createExecutor({ client: fakeClient({ canTrade: false }), registry, ledger: memoryLedger(), mode: "live" });
    assert.equal((await frozen.handle(fromFreqtrade({ type: "entry_fill", trade_id: 10, pair: "EUR/USDT", stake_amount: 5 }))).outcome, "skipped");
    const ex = createExecutor({ client: fakeClient(), registry, ledger: memoryLedger(), mode: "live" });
    assert.equal((await ex.handle(fromDecision({ source: "tradingagents", ticker: "EUR", decision: "HOLD" }))).outcome, "hold");
  });
});

// ------------------------------------------------------------------ server
describe("server", () => {
  let server, base, ledger;
  before(async () => {
    ledger = memoryLedger();
    const executor = createExecutor({ client: fakeClient(), registry, ledger, mode: "shadow" });
    const app = createBridgeApp({ executor, secret: "s3cret-for-tests" });
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });
  after(() => server.close());

  const post = (path, body, headers = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("refuses a signal without the shared secret", async () => {
    const res = await post("/signal/freqtrade", { type: "entry_fill", trade_id: 1, pair: "EUR/USDT", stake_amount: 5 });
    assert.equal(res.status, 401);
    assert.equal(ledger.all().length, 0);
  });

  test("accepts a freqtrade webhook with the secret in the URL", async () => {
    const res = await post("/signal/freqtrade?key=s3cret-for-tests", { type: "entry_fill", trade_id: 2, pair: "EUR/USDT", stake_amount: 5 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).outcome, "shadow");
  });

  test("a malformed body is refused before the secret check reads it, and leaks nothing", async () => {
    const raw = (headers) => fetch(`${base}/signal`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{not json" });
    const noKey = await raw({});
    assert.equal(noKey.status, 401);
    const withKey = await raw({ "x-bridge-secret": "s3cret-for-tests" });
    assert.equal(withKey.status, 400);
    const text = await withKey.text();
    assert.doesNotMatch(text, /node_modules|at .*\.js|\\bridge\\/, "no stack trace or paths");
  });

  test("accepts a decision with the secret in a header, and rejects junk", async () => {
    const ok = await post("/signal", { source: "tradingagents", ticker: "NVDA", decision: "BUY", sizeUsd: 5 }, { "x-bridge-secret": "s3cret-for-tests" });
    assert.equal(ok.status, 200);
    const bad = await post("/signal", { ticker: 42 }, { "x-bridge-secret": "s3cret-for-tests" });
    assert.equal(bad.status, 400);
  });
});

// ------------------------------------------------------------ file ledger
describe("file ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-ledger-"));

  test("remembers what it handled across a restart", () => {
    const path = join(dir, "restart.jsonl");
    fileLedger(path).append({ signal: { id: "a" }, outcome: "traded" });
    const again = fileLedger(path);
    assert.equal(again.has("a"), true);
    assert.equal(again.has("b"), false);
    assert.equal(again.all().length, 1);
  });

  test("a corrupt line is skipped, not fatal", () => {
    const path = join(dir, "corrupt.jsonl");
    writeFileSync(path, JSON.stringify({ signal: { id: "ok" }, outcome: "shadow" }) + "\n");
    appendFileSync(path, '{"signal":{"id":"half"'); // a crash mid-write
    const l = fileLedger(path);
    assert.equal(l.has("ok"), true);
    assert.equal(l.all().length, 1);
  });
});

// ------------------------------------------------------ against the chain
describe("live, on a local chain", () => {
  const deployer = walletFor(0);
  const owner = walletFor(1);
  const agent = walletFor(2);
  const TOKEN = artifact("MockToken");
  const VENUE = artifact("OracleVenue");
  let mandate;

  async function deploy(name, args = []) {
    const { abi, bytecode } = artifact(name);
    const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
  }
  async function send(address, abi, functionName, args) {
    const hash = await deployer.writeContract({ address, abi, functionName, args, account: deployer.account, chain: localChain });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  before(async () => {
    await waitForNode();
    const usdc = await deploy("MockToken", ["USDC", 6]);
    const eurc = await deploy("MockToken", ["EURC", 6]);
    const feed = await deploy("MockFeed", [8, 114_000_000n]);
    const venue = await deploy("OracleVenue", [usdc, 6]);
    await send(venue, VENUE.abi, "list", [eurc, feed, 6]);
    await send(usdc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
    await send(eurc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
    await send(usdc, TOKEN.abi, "mint", [account(1).address, 1_000_000_000n]);
    const factory = await deploy("MandateFactory");
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    mandate = await createMandate({
      publicClient,
      ownerWallet: owner,
      factory,
      name: "bridge test",
      agent: account(2).address,
      base: usdc,
      venue,
      rules: { maxTradeUsd: 10, maxLossPercent: 10, maxSlippagePercent: 1, expiresAt: new Date((chainNow + 7 * 86_400) * 1000), maxPriceAgeSeconds: 86_400 },
      assets: [{ token: eurc, feed }],
      deposit: "50",
    });
  });

  test("a freqtrade entry buys EURC through the mandate, and its exit sells it back", async () => {
    const client = new MandateClient({ publicClient, wallet: agent, address: mandate });
    const ledger = memoryLedger();
    const ex = createExecutor({ client, registry, ledger, mode: "live" });

    const bought = await ex.handle(fromFreqtrade({ type: "entry_fill", trade_id: 21, pair: "EUR/USDT", stake_amount: 25 }));
    assert.equal(bought.outcome, "traded", JSON.stringify(bought));
    assert.equal(bought.clamped, true, "25 was capped at the $10 per-trade limit");
    let s = await client.status();
    assert.ok(s.holdings.find((h) => h.symbol === "EURC").amount > 8);

    const sold = await ex.handle(fromFreqtrade({ type: "exit_fill", trade_id: 21, pair: "EUR/USDT" }));
    assert.equal(sold.outcome, "traded", JSON.stringify(sold));
    s = await client.status();
    assert.ok(s.holdings.find((h) => h.symbol === "EURC").amount < 0.01, "the whole position came back");

    const shadow = await ex.handle(fromFreqtrade({ type: "entry_fill", trade_id: 22, pair: "BTC/USDT", stake_amount: 5 }));
    assert.equal(shadow.outcome, "shadow");
    assert.deepEqual(ledger.all().map((r) => r.outcome), ["traded", "traded", "shadow"]);
  });
});
