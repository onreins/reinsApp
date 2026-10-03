/**
 * Looking after hosted agents by hand: seeing them all, and resuming one a
 * person has checked.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../runner/store.js";
import { run } from "../runner/admin.js";

const KEY = "0x" + "11".repeat(20);
const MANDATE = "0x" + "22".repeat(20);
let dir, config, lines;
const out = (l) => lines.push(l);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-admin-"));
  config = { dbPath: join(dir, "r.sqlite") };
  lines = [];
  const s = openStore(config.dbPath);
  s.issueKey({ address: KEY, sealed: { enc: "aa", iv: "bb", tag: "cc" }, strategy: "balance", settings: { target: 0.5 }, at: Date.now() });
  s.bind(KEY, MANDATE, Date.now());
  s.begin("u", { mandate: MANDATE, strategy: "balance", signal: { id: "u", side: "buy", reason: "Buying $1.00 of EURC" }, at: Date.now() });
  s.settle("u", "unknown", "receipt lost");
  s.pause(KEY, "An earlier trade's outcome is unknown.", Date.now());
  s.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("status shows each key, its agent, state and latest decision", () => {
  run(["status"], { config, out });
  const text = lines.join("\n");
  assert.match(text, new RegExp(KEY));
  assert.match(text, /paused: An earlier trade's outcome is unknown/);
  assert.match(text, /latest  unknown/);
});

test("resume needs a verdict and a note saying what was checked", () => {
  assert.throws(() => run(["resume", MANDATE, "looked"], { config, out }), /--sent or --not-sent/);
  assert.throws(() => run(["resume", MANDATE, "--sent"], { config, out }), /note/);
});

test("resume by agent address marks the unknown trade checked and runs it again", () => {
  run(["resume", MANDATE, "--sent", "tx", "confirmed", "on", "explorer"], { config, out });
  const s = openStore(config.dbPath);
  assert.equal(s.keys({ running: true }).length, 1);
  assert.equal(s.decision("u").outcome, "reviewed-sent");
  s.close();
  assert.match(lines.join(""), /1 trade\(s\) marked as checked/);
});
