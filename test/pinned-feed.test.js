/**
 * Arc testnet has no Chainlink feeds, so a mandate running there needs a price
 * from somewhere. PinnedFeed carries an answer copied from the real mainnet
 * feed. It must behave exactly like the Chainlink shape a Mandate reads, and it
 * must refuse anyone but its publisher.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";

const deployer = walletFor(0);
const stranger = walletFor(4);
const FEED = artifact("PinnedFeed");
const EURC_USD = 113_790_000n; // $1.1379, 8 decimals, as the mainnet feed reported

let feed;

async function deployFeed() {
  const hash = await deployer.deployContract({
    abi: FEED.abi,
    bytecode: FEED.bytecode,
    args: [8, "EURC / USD (pinned from Arc mainnet)", EURC_USD],
    account: deployer.account,
    chain: localChain,
  });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

const read = (functionName, args = []) => publicClient.readContract({ address: feed, abi: FEED.abi, functionName, args });

const send = (wallet, functionName, args = []) =>
  wallet
    .writeContract({ address: feed, abi: FEED.abi, functionName, args, account: wallet.account, chain: localChain })
    .then((hash) => publicClient.waitForTransactionReceipt({ hash }));

before(async () => {
  await waitForNode();
  feed = await deployFeed();
});

describe("the shape a Mandate expects", () => {
  test("reports its decimals and description", async () => {
    assert.equal(await read("decimals"), 8);
    assert.equal(await read("description"), "EURC / USD (pinned from Arc mainnet)");
  });

  test("answers with the price it was deployed with, stamped at deployment", async () => {
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await read("latestRoundData");
    assert.equal(answer, EURC_USD);
    assert.equal(roundId, 1n);
    assert.equal(answeredInRound, 1n);
    assert.equal(startedAt, updatedAt, "a pinned feed has no round duration");

    const now = Number((await publicClient.getBlock()).timestamp);
    assert.ok(now - Number(updatedAt) < 120, `stamped ${now - Number(updatedAt)}s ago`);
  });
});

describe("publishing", () => {
  test("the publisher can push a new answer, and the round advances", async () => {
    const next = 114_500_000n;
    await send(deployer, "publish", [next]);
    const [roundId, answer] = await read("latestRoundData");
    assert.equal(answer, next);
    assert.equal(roundId, 2n);
  });

  test("a new answer refreshes the timestamp, so staleness is measured from the push", async () => {
    const before = (await read("latestRoundData"))[3];
    await send(deployer, "publish", [114_600_000n]);
    const after = (await read("latestRoundData"))[3];
    assert.ok(after >= before, `timestamp went backwards: ${before} → ${after}`);
  });

  test("nobody else can move the price", async () => {
    await expectRevert(send(stranger, "publish", [1n]), "NotPublisher");
  });

  test("refuses a zero or negative answer, which would break every valuation", async () => {
    await expectRevert(send(deployer, "publish", [0n]), "BadAnswer");
    await expectRevert(send(deployer, "publish", [-1n]), "BadAnswer");
  });
});

describe("handing over the publisher", () => {
  test("the publisher can pass the role on, and then loses it", async () => {
    const fresh = await deployFeed();
    const at = (functionName, args = []) => publicClient.readContract({ address: fresh, abi: FEED.abi, functionName, args });
    const write = (wallet, functionName, args) =>
      wallet
        .writeContract({ address: fresh, abi: FEED.abi, functionName, args, account: wallet.account, chain: localChain })
        .then((hash) => publicClient.waitForTransactionReceipt({ hash }));

    await write(deployer, "setPublisher", [account(4).address]);
    assert.equal((await at("publisher")).toLowerCase(), account(4).address.toLowerCase());

    await write(stranger, "publish", [115_000_000n]);
    assert.equal((await at("latestRoundData"))[1], 115_000_000n);

    await expectRevert(write(deployer, "publish", [116_000_000n]), "NotPublisher");
  });

  test("refuses to hand the role to nobody, which would freeze the price forever", async () => {
    await expectRevert(send(deployer, "setPublisher", ["0x0000000000000000000000000000000000000000"]), "BadPublisher");
  });
});
