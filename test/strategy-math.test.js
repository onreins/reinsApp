/**
 * The strategy page's numbers: rebasing a backtest curve to a start date,
 * drawdowns, whether an agent's loss limit would have frozen it, and the scale
 * for the year-by-year bars. The page script is a browser file, so it is
 * loaded into a sandbox with a stand-in window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL("../app/public/strategy-math.js", import.meta.url), "utf8"), sandbox);
const M = sandbox.window.ReinsStrategyMath;

const curve = [
  { t: 100, index: 2 },
  { t: 200, index: 4 },
  { t: 300, index: 3 },
  { t: 400, index: 5 },
  { t: 500, index: 1.5 },
];

test("rebases a curve to growth of $1 from the first point on or after the start", () => {
  const r = M.rebase(curve, 200);
  assert.deepEqual(r.map((p) => p.t), [200, 300, 400, 500]);
  assert.deepEqual(r.map((p) => p.v), [1, 0.75, 1.25, 0.375]);
});

test("drawdown is how far each point sits below the highest point so far", () => {
  const dd = M.drawdowns([1, 2, 1.5, 3, 0.75]);
  assert.deepEqual(dd, [0, 0, -0.25, 0, -0.75]);
});

test("finds the lowest point and when it happened", () => {
  const low = M.lowest(M.rebase(curve, 200));
  assert.equal(low.v, 0.375);
  assert.equal(low.t, 500);
});

test("a loss limit freezes the first time value falls below the floor under the deposit", () => {
  const pts = M.rebase(curve, 200); // 1, 0.75, 1.25, 0.375
  const frozen = M.freezeAt(pts, 20); // floor 0.8
  // The sandbox's objects have their own prototype, so compare the fields.
  assert.equal(frozen.t, 300);
  assert.equal(frozen.v, 0.75);
  assert.equal(M.freezeAt(pts, 70), null);
});

test("landing exactly on the floor is not a freeze, as in the contract", () => {
  const pts = M.rebase(curve, 200); // 0.75 sits exactly on a 25% floor
  assert.equal(M.freezeAt(pts, 25).t, 500);
});

test("the floor is measured from the deposit, not from the peak", () => {
  // Falls 40% from its peak of 2 but never 40% below the deposit of 1.
  const pts = [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 1.2 }];
  assert.equal(M.freezeAt(pts, 40), null);
});

test("the loss limit sits a little beyond the worst backtested drop, between 10% and 50%", () => {
  assert.equal(M.lossLimit(-0.39), 45);
  assert.equal(M.lossLimit(-0.13), 20);
  assert.equal(M.lossLimit(-0.02), 10);
  assert.equal(M.lossLimit(-0.9), 50);
  assert.equal(M.lossLimit(-0.15), 20, "float noise must not push it up a step");
});

test("year bars are scaled to the ordinary years, so one huge year cannot flatten the rest", () => {
  const cap = M.yearCap([4.94, -0.11, 0.65, 0.53], [3.0, -0.6, 1.2, 0.9]);
  assert.ok(cap < 4.94, "the outlier is clipped");
  assert.ok(cap >= 1.2, "every other year fits");
});

test("a year scale never collapses to zero", () => {
  assert.ok(M.yearCap([0, 0], [0, 0]) > 0);
});

test("a clipped year keeps its two bars in proportion, so the winner still shows", () => {
  const bars = M.yearBars(4.94, 10.62, 3.4);
  assert.equal(bars.scaled, true);
  assert.equal(bars.b, 3.4);
  assert.ok(Math.abs(bars.s - 3.4 * (4.94 / 10.62)) < 1e-9);
});

test("a year inside the scale is drawn as is", () => {
  assert.deepEqual({ ...M.yearBars(0.4, -0.2, 3.4) }, { s: 0.4, b: -0.2, scaled: false });
});

test("a clipped year keeps signs", () => {
  const bars = M.yearBars(-0.2, 8, 3.4);
  assert.ok(bars.s < 0);
  assert.equal(bars.b, 3.4);
});
