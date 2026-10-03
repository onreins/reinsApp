/**
 * The runner's memory: which trading keys it holds, which agent each one runs
 * and on what strategy, and every decision it made, written before it acts.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../runner/store.js";

const SEALED = { enc: "aa", iv: "bb", tag: "cc" };
const KEY = "0x" + "11".repeat(20);
const MANDATE = "0x" + "22".repeat(20);
const HOUR = 3_600_000;

let store;
beforeEach(() => { store = openStore(":memory:"); });

describe("hosted keys", () => {
  test("a key is issued unbound, then bound to the agent that uses it", () => {
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: { target: 0.5 }, at: 1000 });
    assert.equal(store.key(KEY).mandate, null);
    assert.deepEqual(store.key(KEY).settings, { target: 0.5 });
    assert.deepEqual(store.key(KEY).sealed, SEALED);
    store.bind(KEY, MANDATE, 2000);
    assert.equal(store.key(KEY).mandate, MANDATE);
    assert.deepEqual(store.keys({ running: true }).map((k) => k.address), [KEY]);
  });

  test("a paused key is no longer run, and says why", () => {
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: {}, at: 1000 });
    store.bind(KEY, MANDATE, 2000);
    store.pause(KEY, "the owner revoked the trading key", 3000);
    assert.equal(store.keys({ running: true }).length, 0);
    assert.equal(store.key(KEY).pauseReason, "the owner revoked the trading key");
  });

  test("keys never used by an agent are forgotten after a day; bound ones stay", () => {
    const other = "0x" + "33".repeat(20);
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: {}, at: 0 });
    store.issueKey({ address: other, sealed: SEALED, strategy: "balance", settings: {}, at: 0 });
    store.bind(other, MANDATE, 10);
    assert.equal(store.purgeUnbound(25 * HOUR, 24 * HOUR), 1);
    assert.equal(store.key(KEY), null);
    assert.ok(store.key(other));
  });
});

describe("decisions", () => {
  const signal = { id: "d1", side: "buy", asset: "EURC", sizeUsd: 5, reason: "below target" };

  test("written as pending before acting, which the executor doesn't count as handled", () => {
    store.begin("d1", { mandate: MANDATE, strategy: "savings", signal, at: 1000 });
    assert.equal(store.decision("d1").outcome, "pending");
    assert.equal(store.ledger().has("d1"), false);
  });

  test("the executor's record finishes it, with the transaction", () => {
    store.begin("d1", { mandate: MANDATE, strategy: "savings", signal, at: 1000 });
    store.ledger().append({ signal, outcome: "traded", hash: "0xabc", trade: { from: "USDC", to: "EURC", amount: "5" } });
    const d = store.decision("d1");
    assert.equal(d.outcome, "traded");
    assert.equal(d.txHash, "0xabc");
    assert.equal(store.ledger().has("d1"), true);
  });

  test("a duplicate report never overwrites the real outcome", () => {
    store.begin("d1", { mandate: MANDATE, strategy: "savings", signal, at: 1000 });
    store.ledger().append({ signal, outcome: "traded", hash: "0xabc" });
    store.ledger().append({ signal, outcome: "duplicate" });
    assert.equal(store.decision("d1").outcome, "traded");
  });

  test("an agent's decisions come back newest first", () => {
    for (let i = 1; i <= 3; i++) {
      store.begin(`d${i}`, { mandate: MANDATE, strategy: "balance", signal: { ...signal, id: `d${i}` }, at: i * 1000 });
      store.ledger().append({ signal: { ...signal, id: `d${i}` }, outcome: "hold", reason: `pass ${i}` });
    }
    assert.deepEqual(store.decisions(MANDATE, 2).map((d) => d.reason), ["pass 3", "pass 2"]);
  });
});

test("survives a restart, and opening the same file twice is harmless", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  try {
    const path = join(dir, "r.sqlite");
    const first = openStore(path);
    first.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: {}, at: 1 });
    first.close();
    const again = openStore(path);
    assert.ok(again.key(KEY));
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("review fixes", () => {
  test("binding happens once: a key already bound stays with its first agent", () => {
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: {}, at: 1 });
    assert.equal(store.bind(KEY, MANDATE, 2), true);
    assert.equal(store.bind(KEY, "0x" + "99".repeat(20), 3), false);
    assert.equal(store.key(KEY).mandate, MANDATE);
  });

  test("pausing with forget wipes the sealed key, so it can never sign again", () => {
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: {}, owner: MANDATE, at: 1 });
    store.pause(KEY, "revoked", 2, { forget: true });
    assert.deepEqual(store.key(KEY).sealed, { enc: "", iv: "", tag: "" });
    assert.equal(store.keys({ unbound: true }).length, 0, "a wiped key isn't waiting for an agent either");
  });

  test("anything still pending at startup becomes unknown, and is found as unresolved", () => {
    store.begin("d1", { mandate: MANDATE, strategy: "savings", signal: { id: "d1", side: "buy" }, at: 1 });
    assert.equal(store.settleStale("cut off"), 1);
    assert.equal(store.decision("d1").outcome, "unknown");
    assert.equal(store.unresolved(MANDATE).id, "d1");
    store.settle("d1", "traded", "confirmed later");
    assert.equal(store.unresolved(MANDATE), null);
  });

  test("a negative or huge limit is clamped, never unlimited", () => {
    for (let i = 0; i < 3; i++) store.begin(`d${i}`, { mandate: MANDATE, strategy: "balance", signal: { id: `d${i}`, side: "hold" }, at: i });
    assert.equal(store.decisions(MANDATE, -1).length, 1);
    assert.equal(store.decisions(MANDATE, 10_000).length, 3);
  });

  test("old holds are pruned; trades are kept", () => {
    store.begin("h", { mandate: MANDATE, strategy: "balance", signal: { id: "h", side: "hold" }, at: 1 });
    store.ledger().append({ signal: { id: "h" }, outcome: "hold" });
    store.begin("t", { mandate: MANDATE, strategy: "balance", signal: { id: "t", side: "buy" }, at: 1 });
    store.ledger().append({ signal: { id: "t" }, outcome: "traded", hash: "0x1" });
    assert.equal(store.pruneHolds(100), 1);
    assert.deepEqual(store.decisions(MANDATE).map((d) => d.id), ["t"]);
  });

  test("a row with unreadable settings doesn't break reading the others", () => {
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "balance", settings: {}, at: 1 });
    store.bind(KEY, MANDATE, 2);
    const raw = openStore(":memory:");
    raw.close();
    assert.ok(Array.isArray(store.keys({ running: true })));
  });
});

test("gas spend is kept per day and per key, and survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-gas-"));
  try {
    const path = join(dir, "g.sqlite");
    const first = openStore(path);
    first.recordGas({ day: "2026-10-02", address: KEY, wei: 3n, hash: "0x1", at: 1 });
    first.recordGas({ day: "2026-10-02", address: MANDATE, wei: 4n, hash: "0x2", at: 2 });
    first.recordGas({ day: "2026-10-01", address: KEY, wei: 100n, hash: "0x0", at: 0 });
    first.close();
    const again = openStore(path);
    assert.equal(again.gasSpent("2026-10-02"), 7n);
    assert.equal(again.gasSpent("2026-10-02", KEY), 3n);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a trade cut to the per-trade cap says what was actually sent", () => {
  const s = openStore(":memory:");
  s.begin("c", { mandate: MANDATE, strategy: "balance", signal: { id: "c", side: "buy", reason: "Buying $1.00 of EURC" }, at: 1 });
  s.ledger().append({ signal: { id: "c" }, outcome: "traded", clamped: true, trade: { from: "USDC", to: "EURC", amount: "0.5" }, hash: "0x1" });
  assert.equal(s.decision("c").reason, "Buying $1.00 of EURC; sent 0.5 USDC, its per-trade cap");
});

describe("audit improvements", () => {
  test("an identical hold repeats one row, and it moves to the newest time", () => {
    store.begin("h1", { mandate: MANDATE, strategy: "balance", signal: { id: "h1", side: "hold", reason: "inside" }, at: 1 });
    store.ledger().append({ signal: { id: "h1" }, outcome: "hold", reason: "inside" });
    store.repeatHold("h1", 5);
    const [d] = store.decisions(MANDATE);
    assert.equal(d.repeats, 2);
    assert.equal(d.at, 5);
  });

  test("knows the last trade, and the last attempt whatever came of it", () => {
    store.begin("t1", { mandate: MANDATE, strategy: "savings", signal: { id: "t1", side: "buy" }, at: 10 });
    store.ledger().append({ signal: { id: "t1" }, outcome: "traded", hash: "0x1" });
    store.begin("t2", { mandate: MANDATE, strategy: "savings", signal: { id: "t2", side: "buy" }, at: 20 });
    store.ledger().append({ signal: { id: "t2" }, outcome: "refused", rule: "InsufficientOutput" });
    assert.equal(store.lastTradeAt(MANDATE), 10);
    assert.equal(store.lastAct(MANDATE).outcome, "refused");
  });

  const pausedWithUnknown = () => {
    store.issueKey({ address: KEY, sealed: SEALED, strategy: "savings", settings: {}, at: 1 });
    store.bind(KEY, MANDATE, 2);
    store.begin("u", { mandate: MANDATE, strategy: "savings", signal: { id: "u", side: "buy", reason: "Buying" }, at: 50 });
    store.settle("u", "unknown", "receipt lost");
    store.pause(KEY, "check it", 60);
  };

  test("a review that found the trade went through counts as a trade, so savings won't buy again too soon", () => {
    pausedWithUnknown();
    assert.equal(store.resumeReviewed(KEY, { sent: true, note: "tx confirmed on explorer" }), 1);
    assert.equal(store.decision("u").outcome, "reviewed-sent");
    assert.match(store.decision("u").reason, /checked: tx confirmed on explorer/);
    assert.equal(store.lastTradeAt(MANDATE), 50);
    assert.equal(store.unresolved(MANDATE), null);
    assert.equal(store.keys({ running: true }).length, 1);
  });

  test("a review that found nothing was sent doesn't count as a trade", () => {
    pausedWithUnknown();
    store.resumeReviewed(KEY, { sent: false, note: "no tx on explorer" });
    assert.equal(store.decision("u").outcome, "reviewed-unsent");
    assert.equal(store.lastTradeAt(MANDATE), null);
  });

  test("resume changes nothing unless the key is paused and still has its key", () => {
    pausedWithUnknown();
    store.resumeReviewed(KEY, { sent: true, note: "ok" });
    assert.throws(() => store.resumeReviewed(KEY, { sent: true, note: "again" }), /isn't paused/);
    store.pause(KEY, "revoked", 70, { forget: true });
    store.begin("u2", { mandate: MANDATE, strategy: "savings", signal: { id: "u2", side: "buy" }, at: 80 });
    store.settle("u2", "unknown", "lost");
    assert.throws(() => store.resumeReviewed(KEY, { sent: true, note: "x" }), /wiped/);
    assert.equal(store.decision("u2").outcome, "unknown", "the failed resume left the trade as it was");
  });
});
