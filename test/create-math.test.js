/**
 * The create page's choices turned into rules: a personality sets the loss
 * limit, the largest trade (as a share of the deposit) and the price band; a
 * strategy template sets a loss limit from its backtest. Loaded into a sandbox
 * because it is a plain browser script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = { window: {} };
vm.createContext(sandbox);
for (const file of ["strategy-math.js", "create-math.js"]) {
  vm.runInContext(readFileSync(new URL("../app/public/" + file, import.meta.url), "utf8"), sandbox);
}
const C = sandbox.window.ReinsCreate;

test("each personality is stricter than the next", () => {
  const [careful, balanced, bold] = ["careful", "balanced", "bold"].map((id) => C.PERSONALITIES[id]);
  assert.ok(careful.lossPercent < balanced.lossPercent && balanced.lossPercent < bold.lossPercent);
  assert.ok(careful.tradeShare < balanced.tradeShare && balanced.tradeShare < bold.tradeShare);
  assert.ok(careful.bandPercent <= balanced.bandPercent && balanced.bandPercent <= bold.bandPercent);
});

test("the largest trade is a share of the deposit, in cents", () => {
  const r = C.rulesFor(C.PERSONALITIES.balanced, 100);
  assert.equal(r.maxTradeUsd, 20);
  assert.equal(r.maxLossPercent, 10);
  assert.equal(r.maxSlippagePercent, 1);
  assert.equal(C.rulesFor(C.PERSONALITIES.careful, 33.33).maxTradeUsd, 3.33);
});

test("the largest trade never rounds to zero, which the contract refuses", () => {
  assert.ok(C.rulesFor(C.PERSONALITIES.careful, 0).maxTradeUsd >= C.MIN_TRADE_USD);
  assert.ok(C.rulesFor(C.PERSONALITIES.careful, 0.04).maxTradeUsd >= C.MIN_TRADE_USD);
});

test("the price band stays inside the contract's 10% ceiling", () => {
  for (const p of Object.values(C.PERSONALITIES)) assert.ok(p.bandPercent > 0 && p.bandPercent <= 10);
});

test("a template sets its loss limit from its worst backtested drop", () => {
  const p = C.fromTemplate({ id: "momentum", name: "Momentum", stats: { max_drawdown: -0.39 } });
  assert.equal(p.lossPercent, 45);
  assert.equal(p.label, "Momentum");
});

test("name ideas are two words and change with the roll", () => {
  const a = C.nameIdea(0.01, 0.02), b = C.nameIdea(0.9, 0.7);
  assert.match(a, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.notEqual(a, b);
});

test("the floor is the deposit less the loss limit", () => {
  assert.equal(C.floorOf(200, 10), 180);
  assert.equal(C.floorOf(0, 10), 0);
});
