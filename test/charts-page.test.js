// The Charts page: its script tags resolve, the Vela bundle exposes what the
// page uses, and the nav links to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const pub = (p) => new URL(`../app/public/${p}`, import.meta.url);

test("every script and stylesheet the page loads exists", () => {
  const html = readFileSync(pub("charts.html"), "utf8");
  const local = [...html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(local.includes("vendor/vela-workspace.js"));
  for (const p of local) assert.ok(existsSync(pub(p)), `${p} is missing`);
});

test("the bundle exposes the workspace and all three venues", () => {
  const ctx = { console };
  ctx.window = ctx.self = ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(pub("vendor/vela-workspace.js"), "utf8"), ctx);
  for (const name of ["VelaWorkspace", "BinanceProvider", "CoinbaseProvider", "HyperliquidProvider"]) {
    assert.equal(typeof ctx.ReinsVela[name], "function", name);
  }
});

test("the sidebar and the phone tab bar both link to Charts", () => {
  const ui = readFileSync(pub("ui.js"), "utf8");
  assert.equal(ui.match(/\["charts", "Charts", "\/charts\.html"\]/g)?.length, 2);
});
