/**
 * AgenticCommerce — the ERC-8183 escrow we deploy on Arc.
 *
 * Emphasis on the ways money could go to the wrong place, and on the failure
 * modes the standard leaves open: an evaluator who never shows up, a client
 * who evaluates their own purchase, and a hook that misbehaves.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";

const deployer = walletFor(0);
const client = walletFor(1);
const provider = walletFor(2);
const evaluator = walletFor(3);
const stranger = walletFor(4);

const CLIENT = account(1).address;
const PROVIDER = account(2).address;
const EVALUATOR = account(3).address;
const FEE_RECIPIENT = account(5).address;
const ZERO = "0x0000000000000000000000000000000000000000";

const USDC = (n) => BigInt(Math.round(n * 1e6));
const COMMERCE = artifact("AgenticCommerce");
const ERC20 = artifact("MockUSDC");

const STATUS = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 };

before(async () => {
  await waitForNode();
});

async function deploy(name, args = [], wallet = deployer) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args,
    account: wallet.account,
    chain: localChain,
  });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

const send = async (wallet, address, abi, functionName, args) => {
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account,
    chain: localChain,
  });
  return publicClient.waitForTransactionReceipt({ hash });
};

const read = (address, abi, functionName, args = []) =>
  publicClient.readContract({ address, abi, functionName, args });

const balanceOf = (usdc, who) => read(usdc, ERC20.abi, "balanceOf", [who]);

/** A fresh token + escrow, with the client funded. */
async function setup({ feeBps = 0, feeRecipient = FEE_RECIPIENT } = {}) {
  const usdc = await deploy("MockUSDC");
  const commerce = await deploy("AgenticCommerce", [usdc, feeBps, feeRecipient]);
  await send(deployer, usdc, ERC20.abi, "mint", [CLIENT, USDC(1_000_000)]);
  return { usdc, commerce };
}

/** Post a job through to Submitted. */
async function jobThroughSubmit({
  commerce,
  usdc,
  budget = 100,
  evaluatorAddress = EVALUATOR,
  hook = ZERO,
}) {
  const now = (await publicClient.getBlock()).timestamp;
  const receipt = await send(client, commerce, COMMERCE.abi, "createJob", [
    PROVIDER,
    evaluatorAddress,
    now + 3600n,
    '{"spec":"verdict/1"}',
    hook,
  ]);
  const jobId = BigInt(receipt.logs[0].topics[1]);

  await send(provider, commerce, COMMERCE.abi, "setBudget", [jobId, USDC(budget), "0x"]);
  await send(client, usdc, ERC20.abi, "approve", [commerce, USDC(budget)]);
  await send(client, commerce, COMMERCE.abi, "fund", [jobId, "0x"]);
  await send(provider, commerce, COMMERCE.abi, "submit", [jobId, `0x${"ab".repeat(32)}`, "0x"]);
  return jobId;
}

const statusOf = async (commerce, jobId) =>
  Number((await read(commerce, COMMERCE.abi, "getJob", [jobId])).status);

describe("deployment", () => {
  // A constructor revert does not carry a decodable custom error through
  // Hardhat, so these assert that deployment fails at all — and pin the
  // boundary by deploying the largest value that must succeed.
  test("accepts the maximum fee but refuses one basis point more", async () => {
    const usdc = await deploy("MockUSDC");

    const ok = await deploy("AgenticCommerce", [usdc, 250, FEE_RECIPIENT]);
    assert.equal(await read(ok, COMMERCE.abi, "MAX_FEE_BPS"), 250);
    assert.equal(await read(ok, COMMERCE.abi, "feeBps"), 250);

    await assert.rejects(deploy("AgenticCommerce", [usdc, 251, FEE_RECIPIENT]));
  });

  test("refuses a zero token", async () => {
    await assert.rejects(deploy("AgenticCommerce", [ZERO, 0, FEE_RECIPIENT]));
  });

  test("refuses a fee with nowhere to send it", async () => {
    const usdc = await deploy("MockUSDC");
    await assert.rejects(deploy("AgenticCommerce", [usdc, 100, ZERO]));
    // ...but a zero fee needs no recipient.
    const free = await deploy("AgenticCommerce", [usdc, 0, ZERO]);
    assert.equal(await read(free, COMMERCE.abi, "feeBps"), 0);
  });

  test("the fee is immutable — there is no setter to find", () => {
    const setters = COMMERCE.abi.filter(
      (e) => e.type === "function" && /^set(Fee|Owner)|transferOwnership|upgrade/i.test(e.name),
    );
    assert.deepEqual(setters, [], "an agent cannot safely commit funds to a changeable rake");
  });
});

describe("the happy path", () => {
  test("pays the provider when the evaluator accepts", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    const before = await balanceOf(usdc, PROVIDER);
    await send(evaluator, commerce, COMMERCE.abi, "complete", [jobId, `0x${"11".repeat(32)}`, "0x"]);

    assert.equal((await balanceOf(usdc, PROVIDER)) - before, USDC(100));
    assert.equal(await statusOf(commerce, jobId), STATUS.Completed);
    assert.equal(await read(commerce, COMMERCE.abi, "escrowOf", [jobId]), 0n);
  });

  test("takes the protocol fee from the budget, not from thin air", async () => {
    const { usdc, commerce } = await setup({ feeBps: 250 }); // 2.5%
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    const providerBefore = await balanceOf(usdc, PROVIDER);
    const feeBefore = await balanceOf(usdc, FEE_RECIPIENT);

    const quoted = await read(commerce, COMMERCE.abi, "netPayout", [jobId]);
    await send(evaluator, commerce, COMMERCE.abi, "complete", [jobId, `0x${"11".repeat(32)}`, "0x"]);

    const paid = (await balanceOf(usdc, PROVIDER)) - providerBefore;
    const fee = (await balanceOf(usdc, FEE_RECIPIENT)) - feeBefore;

    assert.equal(paid, USDC(97.5));
    assert.equal(fee, USDC(2.5));
    assert.equal(paid, quoted, "netPayout must quote what is actually paid");
    assert.equal(paid + fee, USDC(100), "the escrow is conserved exactly");
  });
});

describe("refusal and expiry", () => {
  test("a rejected job refunds the client, and pays the provider nothing", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    const providerBefore = await balanceOf(usdc, PROVIDER);
    const clientBefore = await balanceOf(usdc, CLIENT);

    await send(evaluator, commerce, COMMERCE.abi, "reject", [jobId, `0x${"22".repeat(32)}`, "0x"]);
    assert.equal(await statusOf(commerce, jobId), STATUS.Rejected);
    assert.equal(await balanceOf(usdc, PROVIDER), providerBefore, "provider paid nothing");

    // A keeper can clean up; the money still goes to the client.
    await send(stranger, commerce, COMMERCE.abi, "claimRefund", [jobId]);
    assert.equal((await balanceOf(usdc, CLIENT)) - clientBefore, USDC(100));
  });

  test("an evaluator who never shows up cannot hold the money hostage", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    await expectRevert(
      send(client, commerce, COMMERCE.abi, "claimRefund", [jobId]),
      "NotYetExpired",
    );

    await publicClient.request({ method: "evm_increaseTime", params: [3601] });
    await publicClient.request({ method: "evm_mine", params: [] });

    const before = await balanceOf(usdc, CLIENT);
    await send(client, commerce, COMMERCE.abi, "claimRefund", [jobId]);

    assert.equal((await balanceOf(usdc, CLIENT)) - before, USDC(100));
    assert.equal(await statusOf(commerce, jobId), STATUS.Expired);
  });

  test("escrow cannot be drained twice", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    await send(evaluator, commerce, COMMERCE.abi, "reject", [jobId, `0x${"22".repeat(32)}`, "0x"]);
    await send(client, commerce, COMMERCE.abi, "claimRefund", [jobId]);

    await expectRevert(send(client, commerce, COMMERCE.abi, "claimRefund", [jobId]), "BadStatus");
  });

  test("a completed job cannot then be refunded", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    await send(evaluator, commerce, COMMERCE.abi, "complete", [jobId, `0x${"11".repeat(32)}`, "0x"]);
    await expectRevert(send(client, commerce, COMMERCE.abi, "claimRefund", [jobId]), "BadStatus");
  });
});

describe("access control", () => {
  test("only the evaluator may complete or reject", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc });
    const r = `0x${"33".repeat(32)}`;

    await expectRevert(send(client, commerce, COMMERCE.abi, "complete", [jobId, r, "0x"]), "NotEvaluator");
    await expectRevert(send(provider, commerce, COMMERCE.abi, "complete", [jobId, r, "0x"]), "NotEvaluator");
    await expectRevert(send(stranger, commerce, COMMERCE.abi, "reject", [jobId, r, "0x"]), "NotEvaluator");
  });

  test("only the provider may quote", async () => {
    const { commerce } = await setup();
    const now = (await publicClient.getBlock()).timestamp;
    const receipt = await send(client, commerce, COMMERCE.abi, "createJob", [
      PROVIDER, EVALUATOR, now + 3600n, "x", ZERO,
    ]);
    const jobId = BigInt(receipt.logs[0].topics[1]);

    await expectRevert(
      send(client, commerce, COMMERCE.abi, "setBudget", [jobId, USDC(10), "0x"]),
      "NotProvider",
    );
  });

  test("a job cannot be funded after its deadline", async () => {
    const { usdc, commerce } = await setup();
    const now = (await publicClient.getBlock()).timestamp;
    const receipt = await send(client, commerce, COMMERCE.abi, "createJob", [
      PROVIDER, EVALUATOR, now + 60n, "x", ZERO,
    ]);
    const jobId = BigInt(receipt.logs[0].topics[1]);
    await send(provider, commerce, COMMERCE.abi, "setBudget", [jobId, USDC(10), "0x"]);
    await send(client, usdc, ERC20.abi, "approve", [commerce, USDC(10)]);

    await publicClient.request({ method: "evm_increaseTime", params: [120] });
    await publicClient.request({ method: "evm_mine", params: [] });

    await expectRevert(send(client, commerce, COMMERCE.abi, "fund", [jobId, "0x"]), "Expired");
  });

  test("a job cannot be created with a deadline already in the past", async () => {
    const { commerce } = await setup();
    const now = (await publicClient.getBlock()).timestamp;
    await expectRevert(
      send(client, commerce, COMMERCE.abi, "createJob", [PROVIDER, EVALUATOR, now - 1n, "x", ZERO]),
      "DeadlineInPast",
    );
  });

  test("a job cannot name a zero evaluator", async () => {
    const { commerce } = await setup();
    const now = (await publicClient.getBlock()).timestamp;
    await expectRevert(
      send(client, commerce, COMMERCE.abi, "createJob", [PROVIDER, ZERO, now + 3600n, "x", ZERO]),
      "ZeroAddress",
    );
  });
});

describe("the self-evaluation trap", () => {
  test("is detectable in one call, before the provider does any work", async () => {
    const { usdc, commerce } = await setup();

    const honest = await jobThroughSubmit({ commerce, usdc, evaluatorAddress: EVALUATOR });
    const rigged = await jobThroughSubmit({ commerce, usdc, evaluatorAddress: CLIENT });

    assert.equal(await read(commerce, COMMERCE.abi, "selfEvaluated", [honest]), false);
    assert.equal(await read(commerce, COMMERCE.abi, "selfEvaluated", [rigged]), true);
  });

  test("a self-evaluating client really can take the money back", async () => {
    // Not a bug in this contract — it is the standard's hole, demonstrated so
    // the reason `selfEvaluated` exists is on the record.
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100, evaluatorAddress: CLIENT });

    const clientBefore = await balanceOf(usdc, CLIENT);
    const providerBefore = await balanceOf(usdc, PROVIDER);

    await send(client, commerce, COMMERCE.abi, "reject", [jobId, `0x${"44".repeat(32)}`, "0x"]);
    await send(client, commerce, COMMERCE.abi, "claimRefund", [jobId]);

    assert.equal((await balanceOf(usdc, CLIENT)) - clientBefore, USDC(100));
    assert.equal(await balanceOf(usdc, PROVIDER), providerBefore);
  });
});

describe("escrow accounting", () => {
  test("tracks escrow per job, not by the contract's balance", async () => {
    const { usdc, commerce } = await setup();
    const jobId = await jobThroughSubmit({ commerce, usdc, budget: 100 });

    // Anyone can inflate the contract's balance; per-job escrow must not move.
    await send(deployer, usdc, ERC20.abi, "mint", [commerce, USDC(500)]);
    assert.equal(await read(commerce, COMMERCE.abi, "escrowOf", [jobId]), USDC(100));

    const before = await balanceOf(usdc, PROVIDER);
    await send(evaluator, commerce, COMMERCE.abi, "complete", [jobId, `0x${"11".repeat(32)}`, "0x"]);
    assert.equal(
      (await balanceOf(usdc, PROVIDER)) - before,
      USDC(100),
      "a donation must not become someone's payout",
    );
  });

  test("gives every job a distinct id", async () => {
    const { usdc, commerce } = await setup();
    const a = await jobThroughSubmit({ commerce, usdc });
    const b = await jobThroughSubmit({ commerce, usdc });
    assert.notEqual(a, b);
  });
});
