/**
 * Card funding (Circle's Onramp Kit): the server mints short-lived widget
 * sessions with a key the browser never sees, and reports a wallet's USDC so
 * the page can tell when the purchase has landed. A fake kit stands in for
 * Circle, so no network and no key.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { KitError } from "@circle-fin/onramp-kit";

import { createApp } from "../app/server.js";
import { onrampConfig } from "../app/onramp.js";

const deployment = {
  network: "testnet",
  chainId: 5042002,
  contracts: { mandateFactory: "0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82" },
  external: { usdc: "0x3600000000000000000000000000000000000000" },
};
const WALLET = "0x1111111111111111111111111111111111111111";

function fakeKit() {
  const calls = [];
  return {
    calls,
    next: null,
    async createSession(body) {
      calls.push(body);
      if (this.next) throw this.next;
      return { sessionId: "s1", sessionToken: "t1", widgetUrl: "https://onramp-sandbox.arc.io/?t=t1", destinationWallet: body.destinationAddress, expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
    },
  };
}

async function start(opts) {
  const app = createApp({ deployment, ...opts });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const post = async (base, path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

describe("configuration", () => {
  test("is off without a key, and sandbox unless told otherwise", () => {
    assert.equal(onrampConfig({}).enabled, false);
    const c = onrampConfig({ ONRAMP_API_KEY: "TEST_API_KEY:a:b" });
    assert.equal(c.enabled, true);
    assert.equal(c.environment, "sandbox");
    assert.equal(c.widgetBaseUrl, "https://onramp-sandbox.arc.io");
    assert.equal(c.baseUrl, "https://api-test.circle.com");
    const live = onrampConfig({ ONRAMP_API_KEY: "LIVE_API_KEY:a:b", ONRAMP_ENV: "production", ONRAMP_REFERRER_DOMAIN: "onreins-app.vercel.app" });
    assert.equal(live.widgetBaseUrl, "https://onramp.arc.io");
    assert.equal(live.baseUrl, "https://api.circle.com");
    assert.equal(live.referrerDomain, "onreins-app.vercel.app");
  });

  test("never takes a referrer domain that isn't a bare hostname", () => {
    for (const bad of ["https://x.app", "x.app:443", "x.app/buy", "*.x.app"]) {
      assert.equal(onrampConfig({ ONRAMP_API_KEY: "k", ONRAMP_REFERRER_DOMAIN: bad }).referrerDomain, undefined, bad);
    }
  });
});

describe("the session endpoint", () => {
  let s, kit;
  before(async () => { kit = fakeKit(); s = await start({ onramp: { kit, environment: "sandbox", widgetBaseUrl: "https://onramp-sandbox.arc.io" } }); });
  after(() => s?.server.close());

  test("status says it's on, and which widget origin to trust", async () => {
    const r = await (await fetch(`${s.base}/api/onramp/status`)).json();
    assert.deepEqual(r, { enabled: true, environment: "sandbox", widgetBaseUrl: "https://onramp-sandbox.arc.io" });
  });

  test("mints a session that pays USDC on Arc into the connected wallet, and is never cached", async () => {
    const r = await post(s.base, "/api/onramp/session", { address: WALLET });
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionToken, "t1");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const sent = kit.calls.at(-1);
    assert.equal(sent.destinationAddress, WALLET);
    assert.equal(sent.appUserId, `wallet-${WALLET.toLowerCase()}`);
    assert.deepEqual(sent.assets, { pairs: [{ token: "USDC", chain: "arc" }] });
  });

  test("refuses anything that isn't a wallet address", async () => {
    for (const address of [undefined, "", "0x123", "not an address", WALLET + "00"]) {
      assert.equal((await post(s.base, "/api/onramp/session", { address })).status, 400, String(address));
    }
  });

  test("turns Circle's errors into plain answers with the right status", async () => {
    kit.next = new KitError({ code: 9001, name: "RATE_LIMITED", type: "RATE_LIMIT", recoverability: "RETRYABLE", message: "slow down" });
    const r = await post(s.base, "/api/onramp/session", { address: WALLET });
    kit.next = null;
    assert.equal(r.status, 429);
    assert.match(r.body.error, /try again/i);
  });
});

describe("without a key", () => {
  let s;
  before(async () => { s = await start({ onramp: { env: {} } }); });
  after(() => s?.server.close());

  test("status says it's off, and a session is refused plainly", async () => {
    assert.deepEqual(await (await fetch(`${s.base}/api/onramp/status`)).json(), { enabled: false });
    const r = await post(s.base, "/api/onramp/session", { address: WALLET });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /isn't switched on/);
  });
});

describe("rate limits", () => {
  test("a visitor can't mint sessions in bulk", async () => {
    const s = await start({ onramp: { kit: fakeKit(), environment: "sandbox", widgetBaseUrl: "https://onramp-sandbox.arc.io", perVisitor: { take: (() => { let n = 0; return () => ++n <= 2; })() } } });
    try {
      assert.equal((await post(s.base, "/api/onramp/session", { address: WALLET })).status, 200);
      assert.equal((await post(s.base, "/api/onramp/session", { address: WALLET })).status, 200);
      assert.equal((await post(s.base, "/api/onramp/session", { address: WALLET })).status, 429);
    } finally { s.server.close(); }
  });
});

describe("a wallet's USDC", () => {
  test("reads the balance on chain, in dollars", async () => {
    const publicClient = { readContract: async ({ address, functionName, args }) => (address === deployment.external.usdc && functionName === "balanceOf" && args[0] === WALLET ? 12_345_678n : 0n) };
    const s = await start({ publicClient });
    try {
      const r = await (await fetch(`${s.base}/api/usdc/${WALLET}`)).json();
      assert.deepEqual(r, { address: WALLET, usdc: 12.345678 });
      assert.equal((await fetch(`${s.base}/api/usdc/0x123`)).status, 400);
    } finally { s.server.close(); }
  });
});
