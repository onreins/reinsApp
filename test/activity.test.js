/**
 * The home page's activity feed: every agent's on-chain events merged into
 * one newest-first list, with totals counted over each agent's full history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildActivity } from "../app/activity.js";

const A = "0x00000000000000000000000000000000000000aA";
const B = "0x00000000000000000000000000000000000000bB";

const mandates = [
  { address: A, name: "alpha", createdAtBlock: "100", closed: false },
  { address: B, name: "beta", createdAtBlock: "200", closed: true },
];

// History arrives the way the indexer returns it: newest first.
const histories = new Map([
  [A.toLowerCase(), [
    { block: "150", tx: "0xa3", event: "Frozen", equityUsd: 1.7, floorUsd: 1.8 },
    { block: "120", tx: "0xa2", event: "Traded", sold: { symbol: "USDC", amount: 0.5 }, bought: { symbol: "EURC", amount: 0.43 } },
    { block: "100", tx: "0xa1", event: "Deposited", amount: 2, symbol: "USDC" },
  ]],
  [B.toLowerCase(), [
    { block: "210", tx: "0xb2", event: "Traded", sold: { symbol: "USDC", amount: 1 }, bought: { symbol: "EURC", amount: 0.87 } },
    { block: "205", tx: "0xb1", event: "Traded", sold: { symbol: "EURC", amount: 0.87 }, bought: { symbol: "USDC", amount: 1 } },
  ]],
]);

test("merges every agent's events newest first, tagged with the agent", () => {
  const { events } = buildActivity({ mandates, histories });
  assert.deepEqual(events.map((e) => e.tx ?? `created:${e.name}`), ["0xb2", "0xb1", "created:beta", "0xa3", "0xa2", "0xa1", "created:alpha"]);
  assert.equal(events[0].name, "beta");
  assert.equal(events[0].mandate, B);
});

test("a creation sorts below the agent's other events in the same block", () => {
  const { events } = buildActivity({ mandates, histories });
  const i = events.findIndex((e) => e.tx === "0xa1");
  assert.equal(events[i + 1].event, "Created");
  assert.equal(events[i + 1].block, "100");
});

test("limits the list but counts totals over everything", () => {
  const { events, totals } = buildActivity({ mandates, histories, limit: 2 });
  assert.equal(events.length, 2);
  assert.deepEqual(totals, { agents: 2, live: 1, trades: 3, freezes: 1 });
});

test("an agent whose history is missing still shows its creation", () => {
  const { events } = buildActivity({ mandates, histories: new Map() });
  assert.deepEqual(events.map((e) => e.event), ["Created", "Created"]);
});

test("does not mutate the histories it is given", () => {
  const before = JSON.stringify([...histories]);
  buildActivity({ mandates, histories });
  assert.equal(JSON.stringify([...histories]), before);
});

test("is complete when every agent's history is known", () => {
  const { partial, totals } = buildActivity({ mandates, histories });
  assert.equal(partial, false);
  assert.equal(totals.trades, 3);
});

test("while any history is missing, says so and leaves the totals unknown rather than zero", () => {
  const one = new Map([[A.toLowerCase(), histories.get(A.toLowerCase())]]);
  const { partial, totals, events } = buildActivity({ mandates, histories: one });
  assert.equal(partial, true);
  assert.equal(totals.trades, null);
  assert.equal(totals.freezes, null);
  assert.ok(events.some((e) => e.tx === "0xa3"), "known events still show");
});
