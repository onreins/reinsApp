/**
 * The bridge's risk engine: a layer of plain rules between a strategy's signal and the
 * executor. It only ever narrows what the mandate already allows; the contract still has
 * the last word. Pure logic, no chain needed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createRiskEngine, snapshot } from "../bridge/risk.js";
import { createExecutor } from "../bridge/executor.js";
import { riskFromEnv } from "../bridge/server.js";
import { createRegistry } from "../bridge/registry.js";
import { memoryLedger } from "../bridge/ledger.js";

const registry = createRegistry({ quotes: ["USD", "USDT", "USDC"], map: { EUR: "EURC", EURC: "EURC", NVDA: "NVDAx" } });

/** A mandate status as MandateClient.status() returns it. A 20 % loss limit on a $1,000 baseline. */
function status({ equity = 1000, baseline = 1000, lossPct = 20, cash = 1000, eurc = 0, eurcPrice = 1.1, nvda = 0, nvdaPrice = 180,
  maxTradeUsd = 500 } = {}) {
  return {
    canTrade: true,
    frozen: false,
    equityUsd: equity,
    baselineUsd: baseline,
    floorUsd: baseline * (1 - lossPct / 100),
    rules: { maxTradeUsd, maxLossPercent: lossPct, allowedAssets: ["USDC", "EURC", "NVDAx"] },
    holdings: [
      { symbol: "USDC", amount: cash, valueUsd: cash },
      { symbol: "EURC", amount: eurc, valueUsd: eurcPrice === null ? null : eurc * eurcPrice },
      { symbol: "NVDAx", amount: nvda, valueUsd: nvdaPrice === null ? null : nvda * nvdaPrice },
    ],
  };
}

const buy = (asset = "NVDA") => ({ id: `b-${asset}-${Math.random()}`, side: "buy", asset, quote: "USD" });
const sell = (asset = "NVDA") => ({ id: `s-${asset}-${Math.random()}`, side: "sell", asset, quote: "USD" });

describe("risk engine: the drawdown ladder", () => {
  test("above or near the baseline it is active and lets buys through", async () => {
    const risk = createRiskEngine();
    for (const equity of [1100, 1000, 910]) {
      const v = await risk.review(buy(), "NVDAx", status({ equity, cash: equity }));
      assert.equal(v.level, "active");
      assert.equal(v.allow, true);
    }
  });

  test("past half the loss budget it only allows sells", async () => {
    const risk = createRiskEngine(); // budget $200: 50 % used at equity $900
    const s = status({ equity: 890, cash: 390, nvda: 2.78, nvdaPrice: 180 });
    const b = await risk.review(buy(), "NVDAx", s);
    assert.equal(b.level, "reducing");
    assert.equal(b.allow, false);
    assert.equal(b.rule, "reducing");
    const sl = await risk.review(sell(), "NVDAx", s);
    assert.equal(sl.allow, true);
  });

  test("past 80 % of the loss budget it halts everything until someone looks", async () => {
    const risk = createRiskEngine(); // 80 % used at equity $840
    const s = status({ equity: 830, cash: 330, nvda: 2.78 });
    for (const sig of [buy(), sell()]) {
      const v = await risk.review(sig, "NVDAx", s);
      assert.equal(v.level, "halted");
      assert.equal(v.allow, false);
      assert.equal(v.rule, "halted");
    }
  });
});

describe("risk engine: exposure caps", () => {
  test("a buy is limited to the room left under the per-asset cap", async () => {
    const risk = createRiskEngine({ maxAssetPct: 0.34 }); // cap $340 of $1,000
    const v = await risk.review(buy(), "NVDAx", status({ cash: 820, nvda: 1, nvdaPrice: 180 }));
    assert.equal(v.allow, true);
    assert.ok(Math.abs(v.maxBuyUsd - 160) < 1e-6, `room should be $160, got ${v.maxBuyUsd}`);
  });

  test("an asset already at its cap is not bought", async () => {
    const risk = createRiskEngine({ maxAssetPct: 0.34 });
    const v = await risk.review(buy(), "NVDAx", status({ cash: 640, nvda: 2, nvdaPrice: 180 }));
    assert.equal(v.allow, false);
    assert.equal(v.rule, "asset-cap");
  });

  test("total exposure outside cash is capped too", async () => {
    const risk = createRiskEngine({ maxAssetPct: 1, maxGrossPct: 0.5 }); // $500 of $1,000 outside cash
    const v = await risk.review(buy(), "NVDAx", status({ cash: 600, eurc: 363.64, eurcPrice: 1.1 }));
    assert.ok(Math.abs(v.maxBuyUsd - 100) < 0.01, `gross room should be about $100, got ${v.maxBuyUsd}`);
  });

  test("with an unpriced holding the exposure is unknown, so it won't buy", async () => {
    const risk = createRiskEngine();
    const v = await risk.review(buy(), "NVDAx", status({ cash: 900, eurc: 50, eurcPrice: null }));
    assert.equal(v.allow, false);
    assert.equal(v.rule, "no-price");
  });

  test("a volatile asset gets a smaller cap: cap x min(1, target / its volatility)", async () => {
    const risk = createRiskEngine({ maxAssetPct: 0.4, volTarget: 0.5, volOf: async (sym) => (sym === "NVDAx" ? 1.0 : null) });
    const v = await risk.review(buy(), "NVDAx", status());
    assert.ok(Math.abs(v.maxBuyUsd - 200) < 1e-6, `cap should be 0.4 x 0.5 x $1,000 = $200, got ${v.maxBuyUsd}`);
  });

  test("when no volatility is known it keeps the plain cap", async () => {
    const risk = createRiskEngine({ maxAssetPct: 0.4, volTarget: 0.5, volOf: async () => null });
    const v = await risk.review(buy(), "NVDAx", status());
    assert.ok(Math.abs(v.maxBuyUsd - 400) < 1e-6);
  });
});

describe("risk engine: missing information halts, never guesses", () => {
  test("a stale price feed (no equity) halts rather than computing a drawdown", async () => {
    const risk = createRiskEngine();
    const s = { ...status(), equityUsd: null };
    const v = await risk.review(sell(), "NVDAx", s);
    assert.equal(v.allow, false);
    assert.equal(v.level, "halted");
    assert.equal(v.rule, "no-equity");
  });

  test("a mandate with no loss budget (floor at the baseline) halts", async () => {
    const risk = createRiskEngine();
    const v = await risk.review(buy(), "NVDAx", status({ lossPct: 0 }));
    assert.equal(v.allow, false);
    assert.equal(v.rule, "no-budget");
  });
});

describe("risk snapshot (what the app shows on a vault page)", () => {
  test("names the level, the dollar lines, and each asset's room under its cap", async () => {
    const s = await snapshot(createRiskEngine({ maxAssetPct: 0.34 }), status({ cash: 820, nvda: 1, nvdaPrice: 180 }));
    assert.equal(s.level, "active");
    assert.equal(s.canBuy, true);
    assert.equal(s.canSell, true);
    assert.equal(s.lines.reduceAtUsd, 900); // half of the $200 loss budget
    assert.equal(s.lines.haltAtUsd, 840);
    assert.equal(s.lines.floorUsd, 800);
    const nvda = s.assets.find((a) => a.symbol === "NVDAx");
    assert.ok(Math.abs(nvda.share - 0.18) < 1e-9);
    assert.equal(nvda.capShare, 0.34);
    assert.ok(Math.abs(nvda.roomUsd - 160) < 1e-6);
    assert.equal(s.assets.some((a) => a.symbol === "USDC"), false, "cash is not an exposure");
  });

  test("when halted it says nothing can trade, and why", async () => {
    const s = await snapshot(createRiskEngine(), status({ equity: 830, cash: 330, nvda: 2.78 }));
    assert.equal(s.level, "halted");
    assert.equal(s.canBuy, false);
    assert.equal(s.canSell, false);
    assert.equal(s.rule, "halted");
    assert.match(s.reason, /loss budget/);
  });
});

describe("risk engine: settings from the environment", () => {
  test("RISK_OFF=1 switches it off, and unset or empty values keep the defaults", () => {
    assert.equal(riskFromEnv({ RISK_OFF: "1" }), null);
    const r = riskFromEnv({ RISK_REDUCE_AT: "", RISK_MAX_ASSET_PCT: "0.25" });
    assert.equal(r.config.reduceAt, 0.5);
    assert.equal(r.config.maxAssetPct, 0.25);
  });

  test("a value that isn't a number, or makes no sense, stops the bridge from starting", () => {
    assert.throws(() => riskFromEnv({ RISK_HALT_AT: "lots" }), /RISK_HALT_AT/);
    assert.throws(() => riskFromEnv({ RISK_REDUCE_AT: "0.9", RISK_HALT_AT: "0.5" }), /reduceAt/);
  });
});

describe("risk engine: configuration", () => {
  test("rejects settings that make no sense", () => {
    assert.throws(() => createRiskEngine({ reduceAt: 0.8, haltAt: 0.5 }), /reduceAt/);
    assert.throws(() => createRiskEngine({ maxAssetPct: 0 }), /maxAssetPct/);
    assert.throws(() => createRiskEngine({ maxGrossPct: 1.5 }), /maxGrossPct/);
    assert.throws(() => createRiskEngine({ volTarget: 0.5 }), /volOf/);
  });
});

/** A MandateClient stand-in over a fixed status. */
function client(s) {
  const trades = [];
  return {
    trades,
    async status() { return s; },
    async trade(t) {
      trades.push(t);
      return { hash: "0xabc", sold: { symbol: t.from, amount: Number(t.amount) }, bought: { symbol: t.to, amount: 1 } };
    },
  };
}

describe("executor with a risk engine", () => {
  test("a buy is cut to the risk room and marked clamped", async () => {
    const c = client(status({ cash: 820, nvda: 1, nvdaPrice: 180, maxTradeUsd: 500 }));
    const ex = createExecutor({ client: c, registry, ledger: memoryLedger(), mode: "live", risk: createRiskEngine({ maxAssetPct: 0.34 }) });
    const r = await ex.handle(buy());
    assert.equal(r.outcome, "traded");
    assert.equal(r.clamped, true);
    assert.equal(Number(c.trades[0].amount), 160);
    assert.equal(r.risk.level, "active");
  });

  test("a blocked signal is recorded with the rule that stopped it, and nothing is sent", async () => {
    const c = client(status({ equity: 890, cash: 390, nvda: 2.78 }));
    const ex = createExecutor({ client: c, registry, ledger: memoryLedger(), mode: "live", risk: createRiskEngine() });
    const r = await ex.handle(buy());
    assert.equal(r.outcome, "risk");
    assert.equal(r.rule, "reducing");
    assert.equal(c.trades.length, 0);
  });

  test("while reducing, a sell still goes through", async () => {
    const c = client(status({ equity: 890, cash: 390, nvda: 2.78, nvdaPrice: 180 }));
    const ex = createExecutor({ client: c, registry, ledger: memoryLedger(), mode: "live", risk: createRiskEngine() });
    const r = await ex.handle(sell());
    assert.equal(r.outcome, "traded");
    assert.equal(c.trades[0].from, "NVDAx");
  });
});
