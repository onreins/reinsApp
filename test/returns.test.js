/**
 * Return since funding, chained across money movements.
 *
 * The contract's own ratio (equity / baseline) resets when the owner
 * unfreezes, and a deposit shifts it. Chaining the performance between
 * movements, and counting each movement itself as zero, gives a figure that
 * a reset can't flatter and a deposit can't dilute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { chainIndex } from "../arena/returns.js";

const pt = (equityUsd, baselineUsd, extra = {}) => ({ t: 0, equityUsd, baselineUsd, events: [], ...extra });
const last = (points) => chainIndex(points).at(-1).index;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("with no movements, it is just equity over what went in", () => {
  close(last([pt(100, 100, { reset: true }), pt(103, 100)]), 1.03);
});

test("an unfreeze reset can't hide a loss", () => {
  const points = [
    pt(100, 100, { reset: true, events: ["Deposited"] }),
    pt(95, 100, { events: ["Traded"] }),
    pt(90, 100, { events: ["Frozen"] }),
    pt(92, 100), // just before the unfreeze
    pt(92, 92, { reset: true, events: ["Unfrozen"] }), // baseline re-anchored
    pt(93, 92, { events: ["now"] }),
  ];
  // The contract's ratio now says 93 / 92 = +1.1%. The truth is 92/100 * 93/92 = 0.93: down 7%.
  close(last(points), 0.93);
});

test("a deposit doesn't dilute a gain", () => {
  const points = [
    pt(100, 100, { reset: true, events: ["Deposited"] }),
    pt(110, 100),
    pt(110, 100), // just before the deposit
    pt(160, 150, { reset: true, events: ["Deposited"] }),
    pt(176, 150),
  ];
  // Up 10%, then 10% more on the bigger balance: 1.1 * 1.1.
  close(last(points), 1.21);
});

test("a withdrawal moves neither way", () => {
  const points = [
    pt(100, 100, { reset: true }),
    pt(110, 100),
    pt(110, 100),
    pt(55, 50, { reset: true, events: ["Withdrawn"] }),
    pt(60.5, 50),
  ];
  close(last(points), 1.21);
});

test("a closed mandate that is funded again starts fresh from its old record", () => {
  const points = [
    pt(100, 100, { reset: true }),
    pt(90, 100),
    pt(0, 0, { reset: true, events: ["Withdrawn"] }), // withdrawAll: nothing left to measure
    pt(50, 50, { reset: true, events: ["Deposited"] }),
    pt(55, 50),
  ];
  const out = chainIndex(points);
  close(out[2].index, 0.9);
  close(out.at(-1).index, 0.99); // 0.9, then +10% on the new money
});

test("the input is not changed", () => {
  const points = [pt(100, 100, { reset: true }), pt(101, 100)];
  const before = JSON.stringify(points);
  chainIndex(points);
  assert.equal(JSON.stringify(points), before);
});
