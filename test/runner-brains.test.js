/**
 * The two hosted strategies, as pure functions: an agent's status and settings
 * in, a decision and a plain reason out.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STRATEGIES, settingsFor, decide, signalFor } from "../runner/brains/index.js";

const HOUR = 3_600_000;
// An agent holding `usdc` dollars and `eurc` dollars' worth of EURC.
const agent = (usdc, eurc, extra = {}) => ({
  canTrade: true,
  frozen: false,
  equityUsd: usdc + eurc,
  holdings: [{ symbol: "USDC", amount: usdc, valueUsd: usdc }, { symbol: "EURC", amount: eurc / 1.1, valueUsd: eurc }],
  ...extra,
});

describe("euro savings", () => {
  const s = settingsFor("savings", { buyUsd: 5, everyHours: 24, targetShare: 0.5 });

  test("buys its amount while EURC is under target", () => {
    const d = decide("savings", agent(90, 10), s);
    assert.equal(d.side, "buy");
    assert.equal(d.sizeUsd, 5);
    assert.match(d.reason, /10% of the agent, aiming for 50%/);
  });

  test("buys only the gap when that's smaller than its amount", () => {
    const d = decide("savings", agent(52, 48), s);
    assert.equal(d.side, "buy");
    assert.equal(d.sizeUsd, 2);
  });

  test("holds once it reaches its target", () => {
    const d = decide("savings", agent(50, 50), s);
    assert.equal(d.side, "hold");
    assert.match(d.reason, /reached its 50% target/);
  });

  test("holds when there is no cash left", () => {
    assert.equal(decide("savings", agent(0, 10), s).side, "hold");
  });

  test("waits its interval after its last buy, and says how long", () => {
    const now = 100 * HOUR;
    const d = decide("savings", agent(90, 10), s, { now, lastTradeAt: now - 5 * HOUR });
    assert.equal(d.side, "hold");
    assert.match(d.reason, /bought 5h ago; next buy in about 19h/);
    assert.equal(decide("savings", agent(90, 10), s, { now, lastTradeAt: now - 25 * HOUR }).side, "buy");
  });

  test("never sells", () => {
    assert.notEqual(decide("savings", agent(10, 90), s).side, "sell");
  });
});

describe("50/50 balance", () => {
  const s = settingsFor("balance", { target: 0.5, band: 0.05 });

  test("holds inside the band, and says where it is", () => {
    const d = decide("balance", agent(52, 48), s);
    assert.equal(d.side, "hold");
    assert.match(d.reason, /48%.*45–55%/);
  });

  test("buys back to target when EURC is under the band", () => {
    const d = decide("balance", agent(70, 30), s);
    assert.equal(d.side, "buy");
    assert.equal(d.sizeUsd, 20);
  });

  test("sells the excess when EURC is over the band", () => {
    const d = decide("balance", agent(30, 70), s);
    assert.equal(d.side, "sell");
    assert.ok(Math.abs(d.fraction - 20 / 70) < 1e-9);
    assert.match(d.reason, /70%/);
  });
});

describe("both strategies", () => {
  for (const name of Object.keys(STRATEGIES)) {
    test(`${name} holds when the agent can't trade, and says why`, () => {
      const d = decide(name, agent(70, 30, { canTrade: false, frozen: true }), settingsFor(name, {}));
      assert.equal(d.side, "hold");
      assert.match(d.reason, /frozen/);
    });
    test(`${name} holds when a price is missing rather than guessing`, () => {
      const a = agent(70, 30);
      a.holdings[1].valueUsd = null;
      a.equityUsd = null;
      assert.equal(decide(name, a, settingsFor(name, {})).side, "hold");
    });
    test(`${name} skips a trade too small to be worth sending`, () => {
      const d = decide(name, agent(0.02, 0), settingsFor(name, {}));
      assert.equal(d.side, "hold");
    });
  }
});

describe("settings", () => {
  test("fill in defaults and drop anything unknown", () => {
    const s = settingsFor("balance", { band: 0.1, evil: true });
    assert.deepEqual(s, { target: 0.5, band: 0.1 });
  });

  test("refuse values outside their bounds, naming the setting", () => {
    assert.throws(() => settingsFor("balance", { band: 0.9 }), /band/);
    assert.throws(() => settingsFor("savings", { buyUsd: -1 }), /buyUsd/);
    assert.throws(() => settingsFor("nope", {}), /strategy/);
  });
});

describe("signal ids make each decision once-only", () => {
  const mandate = "0x" + "22".repeat(20);

  test("a pass run twice gives the same id; the next pass a new one", () => {
    const d = { side: "buy", sizeUsd: 5, reason: "r" };
    const a = signalFor({ strategy: "savings", mandate, now: 10 * HOUR, tickMs: 300_000, decision: d });
    const b = signalFor({ strategy: "savings", mandate, now: 10 * HOUR + 1000, tickMs: 300_000, decision: d });
    const c = signalFor({ strategy: "savings", mandate, now: 10 * HOUR + 300_000, tickMs: 300_000, decision: d });
    assert.equal(a.id, b.id);
    assert.notEqual(b.id, c.id);
  });

  test("a signal is in the executor's shape, against dollars", () => {
    const sig = signalFor({ strategy: "balance", mandate, settings: settingsFor("balance", {}), now: 0, tickMs: 300_000, decision: { side: "sell", fraction: 0.25, reason: "over band" } });
    assert.equal(sig.asset, "EURC");
    assert.equal(sig.quote, "USD");
    assert.equal(sig.side, "sell");
    assert.equal(sig.fraction, 0.25);
    assert.equal(sig.source, "reins:balance");
  });
});
