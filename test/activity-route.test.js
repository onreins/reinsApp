/**
 * GET /api/activity end to end, against a local chain: real agents, a real
 * trade, read back through the same server the app runs. Needs `npm run chain`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { createMandate, MandateClient } from "../mandate/sdk.js";
import { createApp } from "../app/server.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const agent = walletFor(2);
const TOKEN = artifact("MockToken");
const VENUE = artifact("OracleVenue");
const EUR_PRICE = 113_800_000n;

let server, base, first;

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(wallet, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  return publicClient.waitForTransactionReceipt({ hash });
}

before(async () => {
  await waitForNode();
  const usdc = await deploy("MockToken", ["USDC", 6]);
  const eurc = await deploy("MockToken", ["EURC", 6]);
  const feed = await deploy("MockFeed", [8, EUR_PRICE]);
  const venue = await deploy("OracleVenue", [usdc, 6]);
  await send(deployer, venue, VENUE.abi, "list", [eurc, feed, 6]);
  await send(deployer, usdc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  await send(deployer, eurc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  await send(deployer, usdc, TOKEN.abi, "mint", [account(1).address, 1_000_000_000n]);
  const factory = await deploy("MandateFactory");
  const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });

  const now = Number((await publicClient.getBlock()).timestamp);
  const make = (name) => createMandate({
    publicClient,
    ownerWallet: owner,
    factory,
    name,
    agent: account(2).address,
    base: usdc,
    venue,
    rules: { maxTradeUsd: 20, maxLossPercent: 10, maxSlippagePercent: 1, expiresAt: new Date((now + 7 * 86_400) * 1000), maxPriceAgeSeconds: 86_400 },
    assets: [{ token: eurc, feed }],
    deposit: "50",
  });
  first = await make("the trader");
  await make("the holder");
  await new MandateClient({ publicClient, wallet: agent, address: first }).trade({ from: "USDC", to: "EURC", amount: "10" });

  const app = createApp({
    deployment: { network: "localhost", chainId: localChain.id, contracts: { mandateFactory: factory }, fromBlock: fromBlock.toString() },
    publicClient,
    snapshot: null,
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test("lists every agent's events newest first, dated, with exact totals", async () => {
  const res = await fetch(`${base}/api/activity`);
  assert.equal(res.status, 200);
  const d = await res.json();

  assert.equal(d.partial, false);
  assert.deepEqual(d.totals, { agents: 2, live: 2, trades: 1, freezes: 0 });
  assert.equal(d.events[0].event, "Traded", "the trade is the newest thing that happened");
  assert.equal(d.events[0].name, "the trader");
  assert.equal(d.events.filter((e) => e.event === "Created").length, 2);
  for (let i = 1; i < d.events.length; i++) assert.ok(Number(d.events[i - 1].block) >= Number(d.events[i].block), "newest first");
  assert.ok(d.events.every((e) => typeof e.t === "number" && e.t > 0), "every event is dated");
});

test("an agent's own page still gets its history, newest first", async () => {
  const res = await fetch(`${base}/api/mandate/${first}`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.history[0].event, "Traded");
  assert.ok(d.history.some((e) => e.event === "Deposited"));
  assert.ok(d.history.length <= 50);
});
