/**
 * The arena reads the truth off the chain: who exists, what they hold, how
 * they're doing, and what they actually did.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { ArenaIndexer, windows } from "../arena/indexer.js";
import { createMandate, MandateClient } from "../mandate/sdk.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const agent = walletFor(2);
const stranger = walletFor(4);
const TOKEN = artifact("MockToken");
const VENUE = artifact("OracleVenue");
const FEED = artifact("MockFeed");
const M = artifact("Mandate");
const EUR_PRICE = 113_800_000n;

let usdc, eurc, feed, venue, factory, indexer, first;

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(wallet, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  return publicClient.waitForTransactionReceipt({ hash });
}
const chainTime = async () => Number((await publicClient.getBlock()).timestamp);

async function makeOne({ name, deposit }) {
  return createMandate({
    publicClient,
    ownerWallet: owner,
    factory,
    name,
    agent: account(2).address,
    base: usdc,
    venue,
    rules: {
      maxTradeUsd: 20,
      maxLossPercent: 10,
      maxSlippagePercent: 1,
      expiresAt: new Date(((await chainTime()) + 7 * 86_400) * 1000),
      maxPriceAgeSeconds: 86_400,
    },
    assets: [{ token: eurc, feed }],
    deposit,
  });
}

before(async () => {
  await waitForNode();
  usdc = await deploy("MockToken", ["USDC", 6]);
  eurc = await deploy("MockToken", ["EURC", 6]);
  feed = await deploy("MockFeed", [8, EUR_PRICE]);
  venue = await deploy("OracleVenue", [usdc, 6]);
  await send(deployer, venue, VENUE.abi, "list", [eurc, feed, 6]);
  await send(deployer, usdc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  await send(deployer, eurc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  await send(deployer, usdc, TOKEN.abi, "mint", [account(1).address, 1_000_000_000n]);

  factory = await deploy("MandateFactory");
  const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
  indexer = new ArenaIndexer({ publicClient, factory, fromBlock });

  first = await makeOne({ name: "fx reversion", deposit: "100" });
  await makeOne({ name: "buy and hold", deposit: "50" });

  // Give the first one a history: one trade, at a fair price.
  await send(deployer, feed, FEED.abi, "set", [EUR_PRICE]);
  await new MandateClient({ publicClient, wallet: agent, address: first }).trade({
    from: "USDC",
    to: "EURC",
    amount: "20",
  });
});

describe("paging", () => {
  test("splits a range into windows the public RPC will accept", () => {
    assert.deepEqual(windows(0n, 5n, 9_999n), [[0n, 5n]]);
    assert.deepEqual(windows(0n, 20_000n, 10_000n), [
      [0n, 10_000n],
      [10_001n, 20_000n],
    ]);
  });
});

describe("the leaderboard", () => {
  test("finds every mandate the factory created, with its name and owner", async () => {
    const list = await indexer.mandates();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((m) => m.name).sort(), ["buy and hold", "fx reversion"]);
    assert.equal(list[0].owner.toLowerCase(), account(1).address.toLowerCase());
    assert.equal(list[0].agent.toLowerCase(), account(2).address.toLowerCase());
  });

  test("shows money, holdings and rules without being told them", async () => {
    await send(deployer, feed, FEED.abi, "set", [EUR_PRICE]);
    const board = await indexer.leaderboard();
    const fx = board.mandates.find((m) => m.name === "fx reversion");

    assert.equal(fx.baselineUsd, 100);
    assert.ok(Math.abs(fx.equityUsd - 100) < 0.01, `equity ${fx.equityUsd}`);
    assert.equal(fx.rules.maxTradeUsd, 20);
    assert.equal(fx.rules.maxLossPercent, 10);
    assert.deepEqual(fx.rules.allowedAssets, ["USDC", "EURC"]);
    assert.equal(fx.floorUsd, 90);

    const eur = fx.holdings.find((h) => h.symbol === "EURC");
    assert.ok(eur.amount > 17 && eur.amount < 18, `holds ${eur.amount} EURC`);
  });

  test("ranks by return, and a loss sorts below a flat mandate", async () => {
    await send(deployer, feed, FEED.abi, "set", [(EUR_PRICE * 90n) / 100n]); // euro falls 10%
    try {
      const board = await indexer.leaderboard();
      assert.equal(board.mandates[0].name, "buy and hold", "the one holding only dollars is unharmed");
      assert.ok(board.mandates[1].returnPct < 0);
    } finally {
      await send(deployer, feed, FEED.abi, "set", [EUR_PRICE]);
    }
  });

  test("reports a frozen mandate as frozen", async () => {
    await send(deployer, feed, FEED.abi, "set", [EUR_PRICE / 2n]); // past the 10% floor
    try {
      await send(stranger, first, M.abi, "checkpoint");
      const board = await indexer.leaderboard();
      assert.equal(board.mandates.find((m) => m.name === "fx reversion").frozen, true);
    } finally {
      await send(deployer, feed, FEED.abi, "set", [EUR_PRICE]);
      await send(owner, first, M.abi, "unfreeze");
    }
  });
});

describe("history", () => {
  test("reads the funding, the trade and the freeze back out of the chain", async () => {
    const events = await indexer.history(first);
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes("Deposited"));
    assert.ok(kinds.includes("Traded"));
    assert.ok(kinds.includes("Frozen"));

    const trade = events.find((e) => e.event === "Traded");
    assert.equal(trade.sold.symbol, "USDC");
    assert.equal(trade.sold.amount, 20);
    assert.equal(trade.bought.symbol, "EURC");
    assert.ok(trade.bought.amount > 17);
    assert.ok(trade.tx.startsWith("0x"));
  });

  test("newest first, and never more than the limit", async () => {
    const events = await indexer.history(first, { limit: 2 });
    assert.equal(events.length, 2);
    assert.ok(BigInt(events[0].block) >= BigInt(events[1].block));
  });
});
