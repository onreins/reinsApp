/**
 * The testnet arbitrage: which token to put into the pool, and how much, to
 * bring its price back to the oracle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { swapToTarget, TOLERANCE_BPS } from "../scripts/arb-testnet-pool.js";

test("EURC too dear in the pool: sell EURC into it", () => {
  const r = swapToTarget({ spot: 0.87035, target: 0.89096, liquidity: 1e7 });
  assert.equal(r.swap.sell, "EURC");
  assert.ok(r.swap.amount > 0n);
  assert.ok(r.gapBps < -200);
});

test("EURC too cheap in the pool: sell USDC into it", () => {
  const r = swapToTarget({ spot: 0.91, target: 0.89, liquidity: 1e7 });
  assert.equal(r.swap.sell, "USDC");
  assert.ok(r.swap.amount > 0n);
});

test("within tolerance, nothing to do", () => {
  const target = 0.89;
  assert.equal(swapToTarget({ spot: target * (1 + (TOLERANCE_BPS - 1) / 10_000), target, liquidity: 1e7 }).swap, null);
});

test("the swap lands on the target: sqrt(price) moves by amount / L", () => {
  const L = 1e7, spot = 0.87, target = 0.89;
  const { swap } = swapToTarget({ spot, target, liquidity: L });
  const after = (Math.sqrt(spot) + Number(swap.amount) / L) ** 2;
  assert.ok(Math.abs(after - target) / target < 1e-6);
});
