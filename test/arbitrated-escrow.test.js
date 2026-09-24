/**
 * End to end: an escrow contract settles on a ruling from the arbiter API.
 *
 * The API judges the work and signs an EIP-712 attestation for this escrow;
 * anyone submits it; the contract checks who signed it and that it is about
 * the exact terms and delivery the parties committed to, then pays or refunds.
 * The attacks it must stop are the interesting part: a forged signer, an
 * attestation made for another escrow, a ruling about a different delivery, a
 * malleable signature, and an abstain trying to move money.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { publicClient, walletFor, account, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { createArbiter } from "../arbiter/app.js";
import { signAttestation } from "../arbiter/attestation.js";
import { jobSpec, deliverable, hashDocument } from "../evaluator/spec.js";

const ESCROW = artifact("ArbitratedEscrow");
const USDC = artifact("MockUSDC");
const deployer = walletFor(0);
const buyer = walletFor(1);
const seller = walletFor(2);
const relayer = walletFor(4);
const ARBITER = account(3);
const AMOUNT = 250_000n; // $0.25 in 6-decimal USDC
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const STATUS = { Open: 1, Delivered: 2, Paid: 3, Refunded: 4 };

const TERMS = jobSpec({
  language: "python",
  timeoutMs: 8000,
  tests: [
    { name: "adds two numbers", stdin: "2 3", expect: { stdout: "5" } },
    { name: "handles negatives", stdin: "-4 2", expect: { stdout: "-2" } },
  ],
});
const GOOD = deliverable("a, b = map(int, input().split())\nprint(a + b)");
const BUGGY = deliverable("a, b = map(int, input().split())\nprint(a * b)");

let usdc;
let escrow;
let otherEscrow;
let arbiter;

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

async function send(wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  return publicClient.waitForTransactionReceipt({ hash });
}

const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
const balance = (who) => read(usdc, USDC.abi, "balanceOf", [who]);
const now = async () => (await publicClient.getBlock()).timestamp;
const statusOf = async (caseId, on = escrow) => (await read(on, ESCROW.abi, "cases", [caseId]))[7];

async function warp(seconds) {
  await publicClient.request({ method: "evm_increaseTime", params: [Number(seconds)] });
  await publicClient.request({ method: "evm_mine", params: [] });
}

/** Buyer opens a case against TERMS; seller delivers `work` if given. Returns the case id. */
async function openAndDeliver(work, { on = escrow, deadlineIn = 3600n } = {}) {
  await send(buyer, usdc, USDC.abi, "approve", [on, AMOUNT]);
  const receipt = await send(buyer, on, ESCROW.abi, "open", [
    seller.account.address,
    ARBITER.address,
    AMOUNT,
    hashDocument(TERMS),
    (await now()) + deadlineIn,
  ]);
  const opened = receipt.logs.find((l) => l.address.toLowerCase() === on.toLowerCase());
  const caseId = opened.topics[1];
  if (work) await send(seller, on, ESCROW.abi, "deliver", [caseId, hashDocument(work)]);
  return caseId;
}

/** Ask the arbiter API for a ruling with an attestation for `on`. */
async function ruling(caseId, work, { on = escrow, deliveryHash } = {}) {
  const res = await fetch(`${arbiter.base}/v1/rulings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terms: { document: TERMS },
      delivery: { document: work, ...(deliveryHash ? { hash: deliveryHash } : {}) },
      attest: { chainId: localChain.id, escrow: on, caseId },
    }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

const settle = (on, attestation, signature = attestation.signature) =>
  send(relayer, on, ESCROW.abi, "settle", [attestation.message, signature]);

before(async () => {
  await waitForNode();
  usdc = await deploy("MockUSDC");
  escrow = await deploy("ArbitratedEscrow", [usdc]);
  otherEscrow = await deploy("ArbitratedEscrow", [usdc]);
  await send(deployer, usdc, USDC.abi, "mint", [buyer.account.address, 100_000_000n]);

  const { app } = createArbiter({ account: ARBITER, backend: "process" });
  arbiter = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r({ server: s, base: `http://127.0.0.1:${s.address().port}` }));
  });
});

after(() => arbiter?.server.close());

describe("settling on a Verdict ruling", () => {
  test("working code: anyone can submit the ruling and the seller is paid", async () => {
    const caseId = await openAndDeliver(GOOD);
    const { attestation, verdict } = await ruling(caseId, GOOD);
    assert.equal(verdict.outcome, "passed");

    const start = await balance(seller.account.address);
    await settle(escrow, attestation);
    assert.equal((await balance(seller.account.address)) - start, AMOUNT);
    assert.equal(await statusOf(caseId), STATUS.Paid);
  });

  test("buggy code: the buyer is refunded", async () => {
    const caseId = await openAndDeliver(BUGGY);
    const { attestation, verdict } = await ruling(caseId, BUGGY);
    assert.equal(verdict.outcome, "failed");

    const start = await balance(buyer.account.address);
    await settle(escrow, attestation);
    assert.equal((await balance(buyer.account.address)) - start, AMOUNT);
    assert.equal(await statusOf(caseId), STATUS.Refunded);
  });

  test("a ruling can only be used once", async () => {
    const caseId = await openAndDeliver(GOOD);
    const { attestation } = await ruling(caseId, GOOD);
    await settle(escrow, attestation);
    await expectRevert(settle(escrow, attestation), "BadStatus");
  });
});

describe("what the contract refuses", () => {
  test("a ruling signed by anyone but the named arbiter", async () => {
    const caseId = await openAndDeliver(BUGGY);
    const { attestation, verdict, hash } = await ruling(caseId, BUGGY);
    const impostor = privateKeyToAccount(generatePrivateKey());
    const forged = await signAttestation({
      account: impostor,
      attest: { chainId: localChain.id, escrow, caseId },
      verdict: { ...verdict, outcome: "passed", score: 100 },
      rulingHash: hash,
    });
    await expectRevert(settle(escrow, forged), "BadSignature");
    assert.equal(await statusOf(caseId), STATUS.Delivered, "nothing moved");

    await settle(escrow, attestation); // the genuine ruling still works
    assert.equal(await statusOf(caseId), STATUS.Refunded);
  });

  test("an attestation made for a different escrow contract", async () => {
    const caseId = await openAndDeliver(GOOD);
    const { attestation } = await ruling(caseId, GOOD, { on: otherEscrow });
    await expectRevert(settle(escrow, attestation), "BadSignature");
  });

  test("a genuine ruling about a different delivery than the one committed", async () => {
    const caseId = await openAndDeliver(BUGGY); // the seller committed the buggy code
    const { attestation } = await ruling(caseId, GOOD); // but this ruling judged the good code
    await expectRevert(settle(escrow, attestation), "CommitmentMismatch");
  });

  test("an abstain, which must never move money", async () => {
    const caseId = await openAndDeliver(BUGGY);
    // What's served doesn't match the committed hash, so Verdict abstains.
    const { attestation, verdict } = await ruling(caseId, GOOD, { deliveryHash: hashDocument(BUGGY) });
    assert.equal(verdict.outcome, "abstain");
    await expectRevert(settle(escrow, attestation), "DoesNotSettle");
  });

  test("the malleable twin of a valid signature", async () => {
    const caseId = await openAndDeliver(GOOD);
    const { attestation } = await ruling(caseId, GOOD);
    const sig = attestation.signature.slice(2);
    const r = sig.slice(0, 64);
    const s = BigInt(`0x${sig.slice(64, 128)}`);
    const v = parseInt(sig.slice(128, 130), 16);
    const twin = `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    await expectRevert(settle(escrow, attestation, twin), "BadSignature");
  });

  test("an arbiter who is one of the parties", async () => {
    await send(buyer, usdc, USDC.abi, "approve", [escrow, AMOUNT]);
    const args = [seller.account.address, seller.account.address, AMOUNT, hashDocument(TERMS), (await now()) + 3600n];
    await expectRevert(send(buyer, escrow, ESCROW.abi, "open", args), "NotNeutral");
  });
});

describe("when nobody rules", () => {
  test("the buyer reclaims an undelivered case after the deadline, not before", async () => {
    const caseId = await openAndDeliver(null, { deadlineIn: 600n });
    await expectRevert(send(buyer, escrow, ESCROW.abi, "reclaim", [caseId]), "TooEarly");
    await warp(601);
    const start = await balance(buyer.account.address);
    await send(buyer, escrow, ESCROW.abi, "reclaim", [caseId]);
    assert.equal((await balance(buyer.account.address)) - start, AMOUNT);
  });

  test("a delivered case gives the arbiter a full evaluation window before reclaim", async () => {
    const caseId = await openAndDeliver(GOOD, { deadlineIn: 600n });
    await warp(601);
    await expectRevert(send(buyer, escrow, ESCROW.abi, "reclaim", [caseId]), "TooEarly");

    // Still inside the window, the arbiter can rule, and the seller is paid.
    const { attestation } = await ruling(caseId, GOOD);
    await settle(escrow, attestation);
    assert.equal(await statusOf(caseId), STATUS.Paid);
  });

  test("after the evaluation window, an unruled delivery is refunded", async () => {
    const caseId = await openAndDeliver(BUGGY, { deadlineIn: 600n });
    await warp(601 + 86_400);
    await send(buyer, escrow, ESCROW.abi, "reclaim", [caseId]);
    assert.equal(await statusOf(caseId), STATUS.Refunded);
  });
});

describe("payouts can't be blocked", () => {
  test("a blocklisted seller is credited and can withdraw later", async () => {
    const caseId = await openAndDeliver(GOOD);
    const { attestation } = await ruling(caseId, GOOD);
    await send(deployer, usdc, USDC.abi, "setBlocked", [seller.account.address, true]);
    try {
      await settle(escrow, attestation);
      assert.equal(await statusOf(caseId), STATUS.Paid, "settlement still succeeds");
      assert.equal(await read(escrow, ESCROW.abi, "withdrawable", [seller.account.address]), AMOUNT);
    } finally {
      await send(deployer, usdc, USDC.abi, "setBlocked", [seller.account.address, false]);
    }
    const start = await balance(seller.account.address);
    await send(seller, escrow, ESCROW.abi, "withdraw", []);
    assert.equal((await balance(seller.account.address)) - start, AMOUNT);
  });
});
