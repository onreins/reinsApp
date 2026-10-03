/**
 * The runner end to end, on a local chain (needs `npm run chain`): real agents
 * created with trading keys the runner issued, run by their strategies through
 * the bridge's executor and the contract's own limits, and the ways it refuses
 * to be used against itself.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, http, formatEther } from "viem";

import { publicClient, walletFor, account, waitForNode, localChain, RPC_URL } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { ArenaIndexer } from "../arena/indexer.js";
import { createMandate } from "../mandate/sdk.js";

import { openStore } from "../runner/store.js";
import { createKeystore } from "../runner/keystore.js";
import { createLoop } from "../runner/loop.js";
import { createGasKeeper } from "../runner/gas.js";
import { settingsFor } from "../runner/brains/index.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const stranger = walletFor(3);
const TOKEN = artifact("MockToken");
const VENUE = artifact("OracleVenue");
const M = artifact("Mandate");
const EUR_PRICE = 113_800_000n;
const TICK_MS = 300_000;

let usdc, eurc, feed, otherFeed, venue, factory, fromBlock;

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
  usdc = await deploy("MockToken", ["USDC", 6]);
  eurc = await deploy("MockToken", ["EURC", 6]);
  feed = await deploy("MockFeed", [8, EUR_PRICE]);
  otherFeed = await deploy("MockFeed", [8, EUR_PRICE]);
  venue = await deploy("OracleVenue", [usdc, 6]);
  await send(deployer, venue, VENUE.abi, "list", [eurc, feed, 6]);
  await send(deployer, usdc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  await send(deployer, eurc, TOKEN.abi, "mint", [venue, 10_000_000_000n]);
  for (const i of [1, 3]) await send(deployer, usdc, TOKEN.abi, "mint", [account(i).address, 10_000_000_000n]); // $10,000 each: every test agent takes $100
  factory = await deploy("MandateFactory");
  fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
});

/** A runner wired to the local chain, its own store and keystore, at a fixed clock. */
function runner({ clock = { t: 1_000 * TICK_MS }, stop = { on: false }, executorFor } = {}) {
  const store = openStore(":memory:");
  const keystore = createKeystore({ masterKey: Buffer.from("0123456789abcdeffedcba98765432100f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex") });
  const indexer = new ArenaIndexer({ publicClient, factory, fromBlock });
  const loop = createLoop({
    store,
    keystore,
    publicClient,
    walletFor: (acct) => createWalletClient({ account: acct, chain: localChain, transport: http(RPC_URL) }),
    discover: () => indexer.mandates(),
    expected: { base: usdc, venue, assets: { [eurc]: feed } },
    tickMs: TICK_MS,
    killSwitch: () => stop.on,
    executorFor,
    now: () => clock.t,
  });
  const gas = createGasKeeper({ publicClient, gasWallet: deployer, store, low: 0.1, high: 0.5, perKeyCap: 1, dailyCap: 5 });
  return { store, keystore, loop, gas, clock, stop };
}

/** Issue a key for a strategy, and create an agent that trades with it. */
async function hostedAgent(r, strategy, { settings = {}, keyOwner = null, creator = owner, priceFeed = feed } = {}) {
  const { address, sealed } = r.keystore.generate();
  r.store.issueKey({ address, sealed, strategy, settings: strategy === "nope" ? {} : settingsFor(strategy, settings), owner: keyOwner, at: r.clock.t });
  const now = Number((await publicClient.getBlock()).timestamp);
  const mandate = await createMandate({
    publicClient,
    ownerWallet: creator,
    factory,
    name: `hosted ${strategy}`,
    agent: address,
    base: usdc,
    venue,
    rules: { maxTradeUsd: 20, maxLossPercent: 10, maxSlippagePercent: 1, expiresAt: new Date((now + 7 * 86_400) * 1000), maxPriceAgeSeconds: 86_400 },
    assets: [{ token: eurc, feed: priceFeed }],
    deposit: "100",
  });
  await r.gas.topUp([address]);
  return { address, mandate };
}

describe("a hosted agent", () => {
  test("is picked up, trades by its strategy inside its limits, and records why", async () => {
    const r = runner();
    const { address, mandate } = await hostedAgent(r, "balance", { keyOwner: account(1).address });
    const first = await r.loop.pass();
    assert.equal(first.bound, 1);
    assert.equal(first.traded, 1);
    assert.equal(r.store.key(address).mandate.toLowerCase(), mandate.toLowerCase());

    const [d] = r.store.decisions(mandate);
    assert.equal(d.outcome, "traded");
    assert.match(d.txHash, /^0x[0-9a-f]{64}$/);
    assert.match(d.reason, /Buying \$50\.00 of EURC/);
    const receipt = await publicClient.getTransactionReceipt({ hash: d.txHash });
    assert.equal(receipt.from.toLowerCase(), address.toLowerCase(), "the trade was signed by the hosted key");
  });

  test("never trades twice for the same decision, however often it's run", async () => {
    const r = runner();
    const { mandate } = await hostedAgent(r, "balance");
    await r.loop.pass();
    const again = await r.loop.pass();
    assert.equal(again.traded, 0);
    assert.equal(again.skipped, 1);
    assert.equal(r.store.decisions(mandate).filter((d) => d.outcome === "traded").length, 1);
  });

  test("an earlier trade it can't confirm stops the agent for a person to check", async () => {
    const r = runner();
    const { address, mandate } = await hostedAgent(r, "balance");
    await r.loop.pass(); // binds it
    r.store.begin("crashed", { mandate, strategy: "balance", signal: { id: "crashed", side: "buy", asset: "EURC", reason: "crashed" }, at: r.clock.t });
    r.clock.t += TICK_MS;
    const pass = await r.loop.pass();
    assert.equal(pass.traded, 0);
    assert.equal(pass.paused, 1);
    assert.match(r.store.key(address).pauseReason, /outcome is unknown/);
  });

  test("an earlier trade confirmed on-chain is settled, and trading carries on", async () => {
    const r = runner();
    const { mandate } = await hostedAgent(r, "balance");
    await r.loop.pass();
    const real = r.store.decisions(mandate)[0];
    r.store.settle(real.id, "unknown", "receipt timed out");
    r.clock.t += TICK_MS;
    await r.loop.pass();
    assert.equal(r.store.decision(real.id).outcome, "traded");
  });

  test("a send that may have gone out is never retried: the agent pauses", async () => {
    const r = runner({ executorFor: () => ({ handle: async () => { const e = new Error("socket hang up"); e.maybeSent = true; throw e; } }) });
    const { address, mandate } = await hostedAgent(r, "balance");
    const pass = await r.loop.pass();
    assert.equal(pass.paused, 1);
    assert.equal(r.store.decisions(mandate)[0].outcome, "unknown");
    assert.match(r.store.key(address).pauseReason, /may have been sent/);
  });

  test("stops, and wipes its key, the moment its owner revokes the key", async () => {
    const r = runner();
    const { address, mandate } = await hostedAgent(r, "balance");
    await r.loop.pass();
    await send(owner, mandate, M.abi, "setAgent", ["0x0000000000000000000000000000000000000000"]);
    r.clock.t += TICK_MS;
    const pass = await r.loop.pass();
    assert.equal(pass.paused, 1);
    assert.equal(r.store.key(address).pauseReason, "The owner revoked the trading key");
    assert.equal(r.store.key(address).sealed.enc, "");
  });

  test("the kill switch sends nothing and records nothing", async () => {
    const r = runner({ stop: { on: true } });
    const { mandate } = await hostedAgent(r, "balance");
    const pass = await r.loop.pass();
    assert.equal(pass.killSwitch, true);
    assert.equal(r.store.decisions(mandate).length, 0);
  });

  test("one broken agent doesn't stop the others", async () => {
    const r = runner();
    await hostedAgent(r, "nope");
    const { mandate } = await hostedAgent(r, "savings", { settings: { buyUsd: 5 } });
    const pass = await r.loop.pass();
    assert.equal(pass.errors, 1);
    assert.equal(pass.traded, 1);
    assert.equal(r.store.decisions(mandate)[0].outcome, "traded");
  });
});

describe("audit improvements", () => {
  test("after a refused trade it waits an hour, says why, then tries again", async () => {
    let refuse = true;
    const r = runner({
      executorFor: ({ ledger }) => ({
        handle: async (signal) => {
          if (!refuse) return { outcome: "traded" };
          const record = { signal, outcome: "refused", rule: "InsufficientOutput", reason: "the pool was off the oracle" };
          ledger.append(record);
          return record;
        },
      }),
    });
    const { mandate } = await hostedAgent(r, "balance");
    await r.loop.pass();
    assert.equal(r.store.lastAct(mandate).outcome, "refused");
    r.clock.t += TICK_MS;
    await r.loop.pass();
    assert.ok(r.store.latest(mandate).reason.includes("refused (InsufficientOutput); trying again within the hour"));
    refuse = false;
    r.clock.t += 61 * 60_000;
    const later = await r.loop.pass();
    assert.equal(later.traded, 1);
  });

  test("the same hold, pass after pass, is one row that counts its repeats", async () => {
    const r = runner();
    const { mandate } = await hostedAgent(r, "savings", { settings: { buyUsd: 5, targetShare: 0.05 } });
    await r.loop.pass(); // buys $5: 5% of the agent, its target
    for (let i = 0; i < 3; i++) { r.clock.t += TICK_MS; await r.loop.pass(); }
    const rows = r.store.decisions(mandate);
    assert.equal(rows.length, 2, "one trade, one repeating hold");
    assert.equal(rows[0].outcome, "hold");
    assert.equal(rows[0].repeats, 3);
  });
});

describe("it won't be used against itself", () => {
  test("an agent built on a different price feed never runs, and the key is wiped", async () => {
    const r = runner();
    const { address } = await hostedAgent(r, "balance", { priceFeed: otherFeed });
    const pass = await r.loop.pass();
    assert.equal(pass.rejected, 1);
    assert.equal(pass.traded, 0);
    assert.match(r.store.key(address).pauseReason, /price feed/);
    assert.equal(r.store.key(address).sealed.enc, "");
  });

  test("a key issued for one owner can't be used by another's agent", async () => {
    const r = runner();
    const { address } = await hostedAgent(r, "balance", { keyOwner: account(1).address, creator: stranger });
    const pass = await r.loop.pass();
    assert.equal(pass.rejected, 1);
    assert.match(r.store.key(address).pauseReason, /owner/);
  });
});

describe("gas", () => {
  test("tops a key up to its refill level, and leaves a full one alone", async () => {
    const r = runner();
    const { address } = r.keystore.generate();
    const [sent] = await r.gas.topUp([address]);
    assert.equal(sent.sent, "0.5");
    assert.equal(formatEther(await publicClient.getBalance({ address })), "0.5");
    assert.deepEqual(await r.gas.topUp([address]), []);
  });

  test("one key can't take more than its own daily cap", async () => {
    const store = openStore(":memory:");
    const keeper = createGasKeeper({ publicClient, gasWallet: deployer, store, low: 0.1, high: 0.5, perKeyCap: 0.5, dailyCap: 5 });
    const address = runner().keystore.generate().address;
    store.recordGas({ day: new Date().toISOString().slice(0, 10), address, wei: 1n, hash: null, at: 0 }); // it already had a little today
    const [r] = await keeper.topUp([address]);
    assert.equal(r.skipped, "this key's daily gas cap is reached");
  });

  test("all keys together stop at the daily cap, which a restart doesn't reset", async () => {
    const store = openStore(":memory:");
    const make = () => createGasKeeper({ publicClient, gasWallet: deployer, store, low: 0.1, high: 0.5, perKeyCap: 1, dailyCap: 0.6 });
    const a = runner().keystore.generate().address, b = runner().keystore.generate().address;
    assert.ok((await make().topUp([a]))[0].sent);
    const [r] = await make().topUp([b]); // a fresh keeper, as after a restart
    assert.equal(r.skipped, "the daily gas cap is reached");
  });
});
