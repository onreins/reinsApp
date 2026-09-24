/**
 * Paging log queries under Arc's RPC limit.
 *
 * Arc's public RPC refuses eth_getLogs ranges of 10,000 blocks or more. A
 * watcher that asked for more than ~83 minutes of history in one query would
 * simply fail, so every range is split into windows the RPC accepts. These
 * tests pin the splitting: no gaps, no overlaps, no window too wide.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { logWindows, LOG_WINDOW } from "../evaluator/index.js";

/** Every block in [from, to] is covered exactly once. */
function assertExactCover(windows, from, to) {
  let next = from;
  for (const [lo, hi] of windows) {
    assert.equal(lo, next, `gap or overlap at ${lo}`);
    assert.ok(hi >= lo, `inverted window ${lo}-${hi}`);
    assert.ok(hi - lo <= LOG_WINDOW, `window ${lo}-${hi} is wider than the RPC allows`);
    next = hi + 1n;
  }
  assert.equal(next, to + 1n, "range not fully covered");
}

describe("log windows", () => {
  test("stays under the RPC's limit", () => {
    // 9,999 is the widest span Arc accepted; 10,000 was refused.
    assert.equal(LOG_WINDOW, 9_999n);
  });

  test("a small range is one query", () => {
    assert.deepEqual(logWindows(100n, 200n), [[100n, 200n]]);
  });

  test("a range exactly one window wide is one query", () => {
    assert.deepEqual(logWindows(0n, 9_999n), [[0n, 9_999n]]);
  });

  test("one block past a window splits into two", () => {
    const w = logWindows(0n, 10_000n);
    assert.equal(w.length, 2);
    assertExactCover(w, 0n, 10_000n);
  });

  test("a day of Arc history pages cleanly", () => {
    // ~172,800 blocks at 0.5s.
    const from = 63_000_000n;
    const to = from + 172_800n;
    const w = logWindows(from, to);
    assert.equal(w.length, 18);
    assertExactCover(w, from, to);
  });

  test("a single block is one query", () => {
    assert.deepEqual(logWindows(5n, 5n), [[5n, 5n]]);
  });

  test("an inverted range produces nothing rather than looping", () => {
    assert.deepEqual(logWindows(10n, 5n), []);
  });
});
