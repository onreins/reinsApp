/**
 * The app server: config for the front-end, and transaction encoding.
 *
 * The browser never encodes ABI by hand and never holds a key. It asks the
 * server for calldata, and the user's wallet signs it. These tests pin down
 * that the calldata is exactly what the contracts expect, and that bad input
 * is refused at the boundary with a reason.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseUnits } from "viem";

import { createApp } from "../app/server.js";
import { artifact } from "../scripts/artifact.js";

const FACTORY = artifact("MandateFactory");
const MANDATE = artifact("Mandate");

const deployment = {
  network: "testnet",
  chainId: 5042002,
  contracts: {
    mandateFactory: "0x09e45d5b84d9c7cf4e8cdf5d5f1ff2b7d3589f82",
    uniswapV4Venue: "0x007d5ad07b7a97fefcbd4302dfeafc11d8485052",
    pinnedFeed: "0xfdde6a331c996d6fddbdce108ba18fff0b7f972e",
  },
  external: {
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  },
};

let server, base;

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const goodRules = {
  maxTradeUsd: 200,
  maxLossPercent: 10,
  maxSlippagePercent: 1,
  maxPriceAgeSeconds: 86_400,
  expiryDays: 90,
};

before(async () => {
  const app = createApp({ deployment });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server?.close());

describe("config", () => {
  test("tells the front-end which chain and contracts it is talking to", async () => {
    const res = await fetch(`${base}/api/config`);
    const cfg = await res.json();
    assert.equal(cfg.chainId, 5042002);
    assert.equal(cfg.contracts.mandateFactory, deployment.contracts.mandateFactory);
    assert.equal(cfg.tokens.USDC.address, deployment.external.usdc);
    assert.ok(cfg.explorer.startsWith("https://"));
  });
});

describe("encoding a create", () => {
  test("compiles human rules into the exact factory call", async () => {
    const { status, body } = await post("/api/tx/create", {
      name: "my first mandate",
      agent: "0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f",
      rules: goodRules,
    });
    assert.equal(status, 200);
    assert.equal(body.to.toLowerCase(), deployment.contracts.mandateFactory.toLowerCase());
    assert.equal(body.chainId, 5042002);

    const { functionName, args } = decodeFunctionData({ abi: FACTORY.abi, data: body.data });
    assert.equal(functionName, "create");
    const [name, agent, tokenBase, venue, rules, tokens, feeds] = args;
    assert.equal(name, "my first mandate");
    assert.equal(agent.toLowerCase(), "0xeacd19be7bde6a8826b9a8252d5bc3ea51c1416f");
    assert.equal(tokenBase.toLowerCase(), deployment.external.usdc.toLowerCase());
    assert.equal(venue.toLowerCase(), deployment.contracts.uniswapV4Venue.toLowerCase());
    assert.equal(rules.maxTradeValue, parseUnits("200", 6));
    assert.equal(rules.maxDrawdownBps, 1000);
    assert.equal(rules.maxSlippageBps, 100);
    assert.equal(rules.maxPriceAge, 86_400);
    const inDays = (Number(rules.expiresAt) - Date.now() / 1000) / 86_400;
    assert.ok(Math.abs(inDays - 90) < 0.01, `expiry ${inDays} days out`);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].toLowerCase(), deployment.external.eurc.toLowerCase());
    assert.equal(feeds[0].toLowerCase(), deployment.contracts.pinnedFeed.toLowerCase());
  });

  test("refuses a loss limit the contract would refuse, with a reason", async () => {
    for (const maxLossPercent of [0, 101, -5]) {
      const { status, body } = await post("/api/tx/create", {
        name: "x",
        agent: "0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f",
        rules: { ...goodRules, maxLossPercent },
      });
      assert.equal(status, 400, `loss ${maxLossPercent}% must be refused`);
      assert.match(body.error, /loss limit/i);
    }
  });

  test("refuses slippage over the contract's 10% ceiling", async () => {
    const { status, body } = await post("/api/tx/create", {
      name: "x",
      agent: "0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f",
      rules: { ...goodRules, maxSlippagePercent: 11 },
    });
    assert.equal(status, 400);
    assert.match(body.error, /slippage/i);
  });

  test("refuses a malformed agent address", async () => {
    const { status, body } = await post("/api/tx/create", {
      name: "x",
      agent: "not-an-address",
      rules: goodRules,
    });
    assert.equal(status, 400);
    assert.match(body.error, /agent/i);
  });

  test("refuses an empty name and a giant one", async () => {
    for (const name of ["", "x".repeat(200)]) {
      const { status } = await post("/api/tx/create", {
        name,
        agent: "0xEAcD19BE7BDe6a8826B9A8252D5Bc3ea51c1416f",
        rules: goodRules,
      });
      assert.equal(status, 400);
    }
  });
});

describe("encoding a deposit", () => {
  test("returns the approve and the deposit, in order", async () => {
    const mandate = "0x991b8687aca6Acd6b92438bb4cE22866827bD632";
    const { status, body } = await post("/api/tx/deposit", { mandate, amountUsd: 25 });
    assert.equal(status, 200);
    assert.equal(body.txs.length, 2);

    const approve = body.txs[0];
    assert.equal(approve.to.toLowerCase(), deployment.external.usdc.toLowerCase());
    const a = decodeFunctionData({
      abi: [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
      data: approve.data,
    });
    assert.equal(a.args[0].toLowerCase(), mandate.toLowerCase());
    assert.equal(a.args[1], parseUnits("25", 6));

    const dep = body.txs[1];
    assert.equal(dep.to.toLowerCase(), mandate.toLowerCase());
    const d = decodeFunctionData({ abi: MANDATE.abi, data: dep.data });
    assert.equal(d.functionName, "deposit");
    assert.equal(d.args[0], parseUnits("25", 6));
  });

  test("refuses a zero or negative deposit", async () => {
    for (const amountUsd of [0, -3]) {
      const { status } = await post("/api/tx/deposit", {
        mandate: "0x991b8687aca6Acd6b92438bb4cE22866827bD632",
        amountUsd,
      });
      assert.equal(status, 400);
    }
  });
});
