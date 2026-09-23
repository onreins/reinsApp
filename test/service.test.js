/**
 * The sandbox service: pricing arithmetic, and that callers are charged for
 * what they used rather than what they reserved.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, deployVault, waitForNode, localChain } from "./helpers.js";
import { createService } from "../service/index.js";
import { PRICING, costOf, ceilingFor, clampTimeout } from "../service/pricing.js";
import { MemoryLedger } from "../src/server.js";
import { openChannel } from "../src/vault.js";
import { signVoucher, encodeVoucher } from "../src/voucher.js";
import { usdc } from "../src/usdc.js";
import { RatchetClient } from "../src/client.js";

const DAY_BLOCKS = 172_800n;
const payer = walletFor(1);
const PROVIDER = account(2).address;

let vault;
let server;
let baseUrl;
let ledger;

before(async () => {
  await waitForNode();
  vault = await deployVault(0);

  ledger = new MemoryLedger();
  const svc = await createService({
    vault,
    provider: PROVIDER,
    chain: localChain,
    publicClient,
    settleAt: usdc("1000"), // no auto-settlement during tests
    ledger,
    backend: "process",
  });

  server = await new Promise((r) => {
    const s = svc.app.listen(0, () => r(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

describe("pricing", () => {
  test("charges a base fee plus time, rounded up to a tick", () => {
    assert.equal(costOf(0), PRICING.base);
    assert.equal(costOf(1), PRICING.base + PRICING.perTick, "any time at all costs one tick");
    assert.equal(costOf(100), PRICING.base + PRICING.perTick);
    assert.equal(costOf(101), PRICING.base + 2n * PRICING.perTick);
    assert.equal(costOf(1000), PRICING.base + 10n * PRICING.perTick);
  });

  test("quotes the worst case for the requested timeout", () => {
    assert.equal(ceilingFor(1000), costOf(1000));
    assert.ok(ceilingFor(30_000) > ceilingFor(1_000), "a longer timeout reserves more");
  });

  test("clamps absurd or missing timeouts", () => {
    assert.equal(clampTimeout(undefined), PRICING.defaultTimeoutMs);
    assert.equal(clampTimeout(0), PRICING.defaultTimeoutMs);
    assert.equal(clampTimeout(-5), PRICING.defaultTimeoutMs);
    assert.equal(clampTimeout("nonsense"), PRICING.defaultTimeoutMs);
    assert.equal(clampTimeout(10 ** 9), PRICING.maxTimeoutMs);
  });

  test("a run costs a fraction of a cent", () => {
    // Sanity on the business: a quick script must stay well under a cent.
    assert.ok(costOf(150) < usdc("0.001"), `150ms run costs ${costOf(150)}`);
  });
});

describe("free endpoints", () => {
  test("health needs no payment", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test("pricing needs no payment and states the terms", async () => {
    const res = await fetch(`${baseUrl}/pricing`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.currency, "USDC");
    assert.ok(body.languages.includes("python"));
    assert.equal(body.payment.vault.toLowerCase(), vault.toLowerCase());
    assert.equal(body.payment.chainId, localChain.id);
  });
});

describe("running code", () => {
  test("refuses to run without payment", async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "payment_required");
  });

  test("runs code and charges for the time it took", async () => {
    const agent = await agentFor("0.20");

    const res = await agent.fetch(`${baseUrl}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "javascript", code: "console.log(6*7)", timeoutMs: 5000 }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.stdout.trim(), "42");
    assert.equal(body.exitCode, 0);
    assert.equal(body.timedOut, false);

    // Charged the real figure, not the 5s ceiling that was reserved.
    assert.equal(body.billing.chargedRaw, costOf(body.durationMs).toString());
    assert.ok(
      BigInt(body.billing.chargedRaw) < ceilingFor(5000),
      "a fast run must cost less than its reservation",
    );
  });

  test("charges for code that crashes — the compute was still spent", async () => {
    const agent = await agentFor("0.20");
    const res = await agent.fetch(`${baseUrl}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "python", code: "raise ValueError('x')", timeoutMs: 5000 }),
    });

    const body = await res.json();
    assert.equal(res.status, 200);
    assert.notEqual(body.exitCode, 0);
    assert.ok(body.stderr.includes("ValueError"));
    assert.ok(BigInt(body.billing.chargedRaw) >= PRICING.base);
  });

  test("kills and bills a run that exceeds its timeout", async () => {
    const agent = await agentFor("0.20");
    const res = await agent.fetch(`${baseUrl}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        language: "python",
        code: "while True: pass",
        timeoutMs: 1200,
      }),
    });

    const body = await res.json();
    assert.equal(body.timedOut, true);
    assert.ok(body.durationMs >= 1200, `killed after ${body.durationMs}ms`);
    // Billed at most the ceiling it reserved, despite overshooting slightly.
    assert.ok(BigInt(body.billing.chargedRaw) <= ceilingFor(1200) + PRICING.perTick * 5n);
  });

  test("an unsupported language is refused and not charged", async () => {
    const agent = await agentFor("0.20");
    const before = ledgerOwed();

    const res = await agent.fetch(`${baseUrl}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "brainfuck", code: "+++", timeoutMs: 2000 }),
    });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "bad_request");
    assert.equal(ledgerOwed(), before, "a rejected request must be free");
  });

  test("captures stdin", async () => {
    const agent = await agentFor("0.20");
    const res = await agent.fetch(`${baseUrl}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        language: "python",
        code: "import sys; print(sys.stdin.read().upper())",
        stdin: "hello",
        timeoutMs: 5000,
      }),
    });

    assert.equal((await res.json()).stdout.trim(), "HELLO");
  });

  test("billing across many runs matches the sum of the individual charges", async () => {
    const agent = await agentFor("0.30");
    let expected = 0n;

    for (let i = 0; i < 6; i++) {
      const res = await agent.fetch(`${baseUrl}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language: "javascript",
          code: `console.log(${i})`,
          timeoutMs: 5000,
        }),
      });
      expected += BigInt((await res.json()).billing.chargedRaw);
    }

    assert.equal(agent.summary().spent, expected, "client and server agree on the bill");
    assert.ok(
      agent.summary().authorised > expected,
      "ceilings were reserved above what was charged",
    );
  });
});

/** A funded agent with its own channel. */
async function agentFor(budget) {
  const wallet = walletFor(1);
  const agent = new RatchetClient({
    wallet,
    publicClient,
    chain: localChain,
    budget,
    deposit: budget,
  });
  return agent;
}

function ledgerOwed() {
  return ledger.all().reduce((a, s) => a + s.owed, 0n);
}
