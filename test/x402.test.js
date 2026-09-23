/**
 * The Circle Gateway path: does the service issue a correct x402 challenge on
 * Arc, and does it quote the price it says it will?
 *
 * These tests do not settle a payment — that needs a funded Gateway balance and
 * Circle's facilitator. They cover everything up to the point money moves,
 * which is the part we control.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { createX402Service, quoteFor, NETWORKS, FACILITATORS } from "../service/x402.js";
import { costOf, clampTimeout, PRICING } from "../service/pricing.js";

const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

let server;
let base;
let svc;

before(async () => {
  svc = await createX402Service({
    sellerAddress: SELLER,
    network: "testnet",
    backend: "process",
  });
  server = await new Promise((r) => {
    const s = svc.app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

/** Pull and decode the x402 challenge from a 402 response. */
async function challenge(body) {
  const res = await fetch(`${base}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const header = res.headers.get("payment-required");
  return {
    res,
    quote: res.headers.get("x-sandbox-quote"),
    payload: header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null,
  };
}

describe("configuration", () => {
  test("targets Arc by CAIP-2, not raw chain id", () => {
    assert.equal(NETWORKS.testnet, "eip155:5042002");
    assert.equal(NETWORKS.mainnet, "eip155:5042");
    assert.equal(svc.network, "eip155:5042002");
  });

  test("uses Circle's hosted facilitator for the chosen network", () => {
    assert.equal(svc.facilitator, FACILITATORS.testnet);
    assert.match(svc.facilitator, /gateway-api-testnet\.circle\.com/);
  });

  test("refuses to start without a seller address", async () => {
    await assert.rejects(
      createX402Service({ sellerAddress: "", network: "testnet", backend: "process" }),
      /sellerAddress is required/,
    );
  });

  test("refuses an unknown network rather than guessing", async () => {
    await assert.rejects(
      createX402Service({ sellerAddress: SELLER, network: "regtest", backend: "process" }),
      /unknown network/,
    );
  });
});

describe("quoting", () => {
  test("quotes from the requested timeout", () => {
    assert.equal(quoteFor(1000), "$0.0007");
    assert.equal(quoteFor(10_000), "$0.0052");
    assert.equal(quoteFor(30_000), "$0.0152");
  });

  test("a shorter timeout is genuinely cheaper", () => {
    const short = Number(quoteFor(500).slice(1));
    const long = Number(quoteFor(20_000).slice(1));
    assert.ok(short < long, `${short} should be below ${long}`);
  });

  test("clamps an absurd timeout instead of quoting it", () => {
    assert.equal(quoteFor(10 ** 9), quoteFor(PRICING.maxTimeoutMs));
  });

  test("the quote matches the pricing table exactly", () => {
    const ms = 2000;
    const expected = costOf(clampTimeout(ms)); // 18dp
    const quoted = BigInt(Math.round(Number(quoteFor(ms).slice(1)) * 1e18));
    assert.equal(quoted, expected);
  });
});

describe("the x402 challenge", () => {
  test("an unpaid request is refused with a 402 and a challenge", async () => {
    const { res, payload } = await challenge({
      language: "python",
      code: "print(1)",
      timeoutMs: 2000,
    });

    assert.equal(res.status, 402);
    assert.ok(payload, "a PAYMENT-REQUIRED header must be present");
    assert.equal(payload.x402Version, 2);
    assert.equal(payload.resource.url, "/v1/run");
  });

  test("the challenge names Arc, USDC, and our seller address", async () => {
    const { payload } = await challenge({ language: "python", code: "print(1)", timeoutMs: 2000 });
    const [option] = payload.accepts;

    assert.equal(option.network, "eip155:5042002", "must settle on Arc testnet");
    assert.equal(option.scheme, "exact");
    assert.equal(option.payTo, SELLER);
    assert.match(option.asset, /^0x[0-9a-fA-F]{40}$/);
  });

  test("the challenge asks for batched, gasless settlement", async () => {
    const { payload } = await challenge({ language: "python", code: "print(1)", timeoutMs: 2000 });
    const [option] = payload.accepts;

    // This is what makes the payer spend no gas: Circle batches the
    // authorizations and pays gas once per batch.
    assert.equal(option.extra.name, "GatewayWalletBatched");
    assert.equal(option.extra.version, "1");
    assert.match(option.extra.verifyingContract, /^0x[0-9a-fA-F]{40}$/);
  });

  test("the amount charged equals the amount quoted", async () => {
    const { quote, payload } = await challenge({
      language: "python",
      code: "print(1)",
      timeoutMs: 2000,
    });

    // The header quote is in dollars; the challenge is in USDC's 6dp units.
    const dollars = Number(quote.slice(1));
    const units = Number(payload.accepts[0].amount);
    assert.equal(units, Math.round(dollars * 1e6), `${quote} should be ${units} units`);
  });

  test("a longer timeout produces a larger charge in the challenge", async () => {
    const cheap = await challenge({ language: "python", code: "print(1)", timeoutMs: 1000 });
    const dear = await challenge({ language: "python", code: "print(1)", timeoutMs: 20_000 });

    assert.ok(
      Number(dear.payload.accepts[0].amount) > Number(cheap.payload.accepts[0].amount),
      "asking for more time must cost more",
    );
  });
});

describe("free endpoints", () => {
  test("health needs no payment and reports the settlement path", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.settlement, "circle-gateway-nanopayments");
    assert.equal(body.network, "eip155:5042002");
  });

  test("pricing needs no payment and states where money goes", async () => {
    const res = await fetch(`${base}/pricing`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.payment.protocol, "x402");
    assert.equal(body.payment.payTo, SELLER);
    assert.equal(body.payment.network, "eip155:5042002");
    assert.ok(body.languages.includes("python"));
  });
});
