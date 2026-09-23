/**
 * The evaluator: does it judge correctly, and — more importantly — does it
 * refuse to judge when it cannot do so honestly?
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { verifyMessage } from "viem";

import { publicClient, walletFor, account, waitForNode, localChain } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { ContentStore } from "../evaluator/store.js";
import { Evaluator, OUTCOME } from "../evaluator/index.js";
import { evaluate, sealVerdict, resolve } from "../evaluator/verify.js";
import {
  canonicalize,
  hashDocument,
  jobSpec,
  deliverable,
  parseJobSpec,
  parseJobDescription,
  encodeJobDescription,
  encodeDeliverableUri,
  decodeDeliverableUri,
  SpecError,
} from "../evaluator/spec.js";
import { AGENTIC_COMMERCE_ABI, VALIDATION_REGISTRY_ABI, JOB_STATUS } from "../evaluator/abi.js";

const deployer = walletFor(0);
const client = walletFor(1);
const provider = walletFor(2);
const evaluatorWallet = walletFor(3);

const CLIENT = account(1).address;
const PROVIDER = account(2).address;
const EVALUATOR = account(3).address;

const USDC = (n) => BigInt(Math.round(n * 1e6));

const SPEC = jobSpec({
  language: "python",
  timeoutMs: 8000,
  tests: [
    { name: "adds", stdin: "2 3", expect: { stdout: "5" } },
    // 0*0 == 0+0, so the buggy implementation passes this one. That is
    // deliberate: it makes partial scores real rather than all-or-nothing.
    { name: "handles zero", stdin: "0 0", expect: { stdout: "0" } },
    { name: "negatives", stdin: "-4 2", expect: { stdout: "-2" } },
  ],
});

const GOOD = "a, b = map(int, input().split())\nprint(a + b)";
const BUGGY = "a, b = map(int, input().split())\nprint(a * b)";

let usdc, jobs, validation, store, storeUrl, specDoc, description;

before(async () => {
  await waitForNode();

  store = new ContentStore();
  storeUrl = await store.listen();

  usdc = await deploy("MockUSDC");
  jobs = await deploy("MockAgenticCommerce", [usdc]);
  validation = await deploy("MockValidationRegistry");

  await send(deployer, usdc, artifact("MockUSDC").abi, "mint", [CLIENT, USDC(100000)]);

  specDoc = store.put(SPEC);
  description = encodeJobDescription({ uri: specDoc.uri, hash: specDoc.hash, summary: "sum" });
});

after(() => store?.close());

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({
    abi,
    bytecode,
    args,
    account: deployer.account,
    chain: localChain,
  });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

async function send(wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account,
    chain: localChain,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

function newEvaluator(opts = {}) {
  return new Evaluator({
    publicClient,
    wallet: evaluatorWallet,
    jobs,
    validation,
    publish: store.publisher(),
    backend: "process",
    ...opts,
  });
}

/** Post, quote, fund and submit a job. Returns its id and deliverable hash. */
async function postJob({ code, budget = 10, desc = description, evaluatorAddress = EVALUATOR }) {
  const now = (await publicClient.getBlock()).timestamp;
  const receipt = await send(client, jobs, AGENTIC_COMMERCE_ABI, "createJob", [
    PROVIDER,
    evaluatorAddress,
    now + 3600n,
    desc,
    "0x0000000000000000000000000000000000000000",
  ]);
  const jobId = BigInt(receipt.logs[0].topics[1]);

  await send(provider, jobs, AGENTIC_COMMERCE_ABI, "setBudget", [jobId, USDC(budget), "0x"]);
  await send(client, usdc, artifact("MockUSDC").abi, "approve", [jobs, USDC(budget)]);
  await send(client, jobs, AGENTIC_COMMERCE_ABI, "fund", [jobId, "0x"]);

  const doc = store.put(deliverable(code));
  await send(provider, jobs, AGENTIC_COMMERCE_ABI, "submit", [
    jobId,
    doc.hash,
    encodeDeliverableUri(doc.uri),
  ]);
  return { jobId, doc };
}

const statusOf = async (jobId) => {
  const job = await publicClient.readContract({
    address: jobs,
    abi: AGENTIC_COMMERCE_ABI,
    functionName: "getJob",
    args: [jobId],
  });
  return JOB_STATUS[job.status];
};

const balanceOf = (address) =>
  publicClient.readContract({
    address: usdc,
    abi: artifact("MockUSDC").abi,
    functionName: "balanceOf",
    args: [address],
  });

describe("canonical hashing", () => {
  test("is independent of key order", () => {
    const a = { spec: "x", language: "python", tests: [1, 2] };
    const b = { tests: [1, 2], language: "python", spec: "x" };
    assert.equal(canonicalize(a), canonicalize(b));
    assert.equal(hashDocument(a), hashDocument(b));
  });

  test("changes when any value changes", () => {
    assert.notEqual(hashDocument({ a: 1 }), hashDocument({ a: 2 }));
    assert.notEqual(hashDocument({ code: "print(1)" }), hashDocument({ code: "print(2)" }));
  });

  test("distinguishes nesting from flattening", () => {
    assert.notEqual(hashDocument({ a: { b: 1 } }), hashDocument({ "a.b": 1 }));
  });
});

describe("spec validation", () => {
  test("rejects a spec with no tests", () => {
    assert.throws(() => jobSpec({ language: "python", tests: [] }), SpecError);
  });

  test("rejects a test that asserts nothing", () => {
    assert.throws(
      () => jobSpec({ language: "python", tests: [{ name: "vague", expect: {} }] }),
      /asserts nothing/,
    );
  });

  test("rejects an unsupported language", () => {
    assert.throws(
      () => jobSpec({ language: "cobol", tests: [{ name: "t", expect: { exitCode: 0 } }] }),
      /unsupported language/,
    );
  });

  test("caps an absurd timeout rather than trusting it", () => {
    const s = jobSpec({
      language: "python",
      timeoutMs: 999_999_999,
      tests: [{ name: "t", expect: { exitCode: 0 } }],
    });
    assert.equal(s.timeoutMs, 30_000);
  });

  test("round-trips the job description pointer", () => {
    const parsed = parseJobDescription(description);
    assert.equal(parsed.uri, specDoc.uri);
    assert.equal(parsed.hash, specDoc.hash);
  });

  test("rejects a description that is not a Verdict pointer", () => {
    assert.throws(() => parseJobDescription("just some text"), /not valid JSON/);
    assert.throws(() => parseJobDescription('{"spec":"other/9"}'), /unsupported job spec/);
  });

  test("round-trips a deliverable uri through optParams bytes", () => {
    const uri = "https://example.com/0xabc";
    assert.equal(decodeDeliverableUri(encodeDeliverableUri(uri)), uri);
    assert.equal(decodeDeliverableUri("0x"), null);
  });
});

describe("judging work", () => {
  test("passes correct code", async () => {
    const doc = store.put(deliverable(GOOD));
    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      backend: "process",
    });

    assert.equal(v.outcome, OUTCOME.PASSED);
    assert.equal(v.score, 100);
    assert.ok(v.tests.every((t) => t.passed));
  });

  test("fails wrong code and says exactly why", async () => {
    const doc = store.put(deliverable(BUGGY));
    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      backend: "process",
    });

    assert.equal(v.outcome, OUTCOME.FAILED);
    assert.ok(v.score < 100);
    const failed = v.tests.find((t) => !t.passed);
    assert.match(failed.reasons[0], /expected stdout/);
  });

  test("fails code that does not run at all", async () => {
    const doc = store.put(deliverable("this is not python"));
    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      backend: "process",
    });
    assert.equal(v.outcome, OUTCOME.FAILED);
    assert.equal(v.score, 0);
  });
});

describe("refusing to judge", () => {
  test("abstains when the deliverable does not match its commitment", async () => {
    const doc = store.put(deliverable(GOOD));
    store.tamper(doc.hash, deliverable(BUGGY)); // swap after committing

    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      backend: "process",
    });

    assert.equal(v.outcome, OUTCOME.ABSTAIN);
    assert.equal(v.code, "deliverable_hash_mismatch");
  });

  test("abstains when the spec does not match its commitment", async () => {
    const doc = store.put(deliverable(GOOD));
    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: `0x${"11".repeat(32)}`, // a hash nobody published
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      backend: "process",
    });
    assert.equal(v.outcome, OUTCOME.ABSTAIN);
    assert.equal(v.code, "spec_hash_mismatch");
  });

  test("abstains when the deliverable cannot be fetched", async () => {
    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: `${storeUrl}/0x${"ab".repeat(32)}`,
      deliverableHash: `0x${"ab".repeat(32)}`,
      backend: "process",
    });
    assert.equal(v.outcome, OUTCOME.ABSTAIN);
    assert.equal(v.code, "deliverable_unavailable");
  });

  test("abstains when no deliverable uri was provided", async () => {
    const v = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: null,
      deliverableHash: `0x${"cd".repeat(32)}`,
      backend: "process",
    });
    assert.equal(v.outcome, OUTCOME.ABSTAIN);
    assert.equal(v.code, "deliverable_uri_missing");
  });

  test("refuses documents that are too large", async () => {
    await assert.rejects(
      resolve(`data:application/json,${encodeURIComponent(JSON.stringify({ x: "y".repeat(2e6) }))}`),
      /exceeds|JSON/,
    );
  });
});

describe("acting on chain", () => {
  test("releases escrow to the provider when work passes", async () => {
    const { jobId } = await postJob({ code: GOOD });
    const before = await balanceOf(PROVIDER);

    const result = await newEvaluator().handleJob(jobId);

    assert.equal(result.outcome, OUTCOME.PASSED);
    assert.equal(await statusOf(jobId), "Completed");
    assert.equal((await balanceOf(PROVIDER)) - before, USDC(10));
  });

  test("refuses escrow when work fails, and the client can reclaim it", async () => {
    const { jobId } = await postJob({ code: BUGGY });
    const providerBefore = await balanceOf(PROVIDER);
    const clientBefore = await balanceOf(CLIENT);

    const result = await newEvaluator().handleJob(jobId);

    assert.equal(result.outcome, OUTCOME.FAILED);
    assert.equal(await statusOf(jobId), "Rejected");
    assert.equal(await balanceOf(PROVIDER), providerBefore, "provider paid nothing");

    await send(client, jobs, AGENTIC_COMMERCE_ABI, "claimRefund", [jobId]);
    assert.equal((await balanceOf(CLIENT)) - clientBefore, USDC(10));
  });

  test("leaves the escrow alone when it abstains", async () => {
    const { jobId, doc } = await postJob({ code: GOOD });
    store.tamper(doc.hash, deliverable(BUGGY));

    const providerBefore = await balanceOf(PROVIDER);
    const clientBefore = await balanceOf(CLIENT);

    const result = await newEvaluator().handleJob(jobId);

    assert.equal(result.outcome, OUTCOME.ABSTAIN);
    assert.equal(result.acted, false);
    // Neither completed nor rejected: the evaluator took no side at all.
    assert.equal(await statusOf(jobId), "Submitted");
    assert.equal(await balanceOf(PROVIDER), providerBefore);
    assert.equal(await balanceOf(CLIENT), clientBefore);
  });

  test("abstains, without acting, when the job description is not a Verdict pointer", async () => {
    const { jobId } = await postJob({ code: GOOD, desc: "do something nice" });
    const result = await newEvaluator().handleJob(jobId);

    assert.equal(result.outcome, OUTCOME.ABSTAIN);
    assert.equal(await statusOf(jobId), "Submitted");
  });

  test("ignores jobs where it does not hold the evaluator seat", async () => {
    const { jobId } = await postJob({ code: GOOD, evaluatorAddress: account(9).address });
    const result = await newEvaluator().handleJob(jobId);

    assert.match(result.skipped, /not our seat/);
    assert.equal(await statusOf(jobId), "Submitted");
  });

  test("will not settle the same job twice", async () => {
    const { jobId } = await postJob({ code: GOOD });
    const ev = newEvaluator();

    assert.equal((await ev.handleJob(jobId)).outcome, OUTCOME.PASSED);
    const second = await ev.handleJob(jobId);
    assert.match(second.skipped, /already handled/);
  });

  test("a restarted evaluator re-reads status and does not double-settle", async () => {
    const { jobId } = await postJob({ code: GOOD });
    await newEvaluator().handleJob(jobId);

    // Fresh instance: no memory of having handled it.
    const restarted = newEvaluator();
    const result = await restarted.handleJob(jobId);
    assert.match(result.skipped, /status is Completed/);
  });

  test("dryRun evaluates without touching the chain", async () => {
    const { jobId } = await postJob({ code: GOOD });
    const result = await newEvaluator({ dryRun: true }).handleJob(jobId);

    assert.equal(result.outcome, OUTCOME.PASSED);
    assert.equal(result.acted, false);
    assert.equal(await statusOf(jobId), "Submitted");
  });
});

describe("ERC-8004 validation", () => {
  test("posts an independent score for an agent", async () => {
    const work = store.put(deliverable(BUGGY));
    const request = store.put({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: work.uri,
      deliverableHash: work.hash,
    });

    await send(client, validation, VALIDATION_REGISTRY_ABI, "validationRequest", [
      EVALUATOR,
      42n,
      request.uri,
      request.hash,
    ]);

    const result = await newEvaluator().handleValidationRequest(request.hash, {
      requestUri: request.uri,
    });

    const status = await publicClient.readContract({
      address: validation,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: "getValidationStatus",
      args: [request.hash],
    });

    assert.equal(status[0], EVALUATOR);
    assert.equal(status[1], 42n);
    assert.equal(status[2], result.verdict.score);
    assert.ok(status[2] > 0 && status[2] < 100, `partial score, got ${status[2]}`);
  });

  test("ignores requests addressed to a different validator", async () => {
    const work = store.put(deliverable(GOOD));
    const request = store.put({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: work.uri,
      deliverableHash: work.hash,
      nonce: "other-validator",
    });

    await send(client, validation, VALIDATION_REGISTRY_ABI, "validationRequest", [
      account(9).address,
      7n,
      request.uri,
      request.hash,
    ]);

    const result = await newEvaluator().handleValidationRequest(request.hash, {
      requestUri: request.uri,
    });
    assert.match(result.skipped, /not addressed to us/);
  });
});

describe("verdict receipts", () => {
  test("are signed by the evaluator and verify against its address", async () => {
    const doc = store.put(deliverable(GOOD));
    const verdict = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      evaluator: EVALUATOR,
      backend: "process",
    });

    const sealed = await sealVerdict(verdict, evaluatorWallet);
    assert.ok(sealed.signature);

    const ok = await verifyMessage({
      address: EVALUATOR,
      message: { raw: sealed.hash },
      signature: sealed.signature,
    });
    assert.equal(ok, true);
  });

  test("record the exact output, so a dispute can be re-run", async () => {
    const doc = store.put(deliverable(BUGGY));
    const verdict = await evaluate({
      specUri: specDoc.uri,
      specHash: specDoc.hash,
      deliverableUri: doc.uri,
      deliverableHash: doc.hash,
      backend: "process",
    });

    const failing = verdict.tests.find((t) => !t.passed);
    assert.ok(typeof failing.stdout === "string", "captured stdout");
    assert.ok(failing.reasons.length > 0, "stated a reason");
    assert.ok(Number.isFinite(failing.durationMs));
  });
});
