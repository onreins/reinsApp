/**
 * The evaluator as a long-running service: does it pick up new work, settle it
 * once, and resume after a restart without skipping or repeating anything?
 *
 * Runs against the real AgenticCommerce contract, with job inputs passed as
 * data: URIs exactly as the live Arc run does.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publicClient, walletFor, account, waitForNode, localChain } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";
import { Evaluator } from "../evaluator/index.js";
import { runOnce, StateFile } from "../evaluator/daemon.js";
import {
  jobSpec,
  deliverable,
  hashDocument,
  canonicalize,
  encodeJobDescription,
  encodeDeliverableUri,
} from "../evaluator/spec.js";
import { AGENTIC_COMMERCE_ABI, JOB_STATUS } from "../evaluator/abi.js";

const deployer = walletFor(0);
const client = walletFor(1);
const provider = walletFor(2);
const evaluatorWallet = walletFor(3);
const CLIENT = account(1).address;
const PROVIDER = account(2).address;
const EVALUATOR = account(3).address;
const ERC20 = artifact("MockUSDC");

const dataUri = (doc) =>
  `data:application/json;base64,${Buffer.from(canonicalize(doc)).toString("base64")}`;

const SPEC = jobSpec({
  language: "python",
  timeoutMs: 8000,
  tests: [{ name: "adds", stdin: "2 3", expect: { stdout: "5" } }],
});
const GOOD = "a, b = map(int, input().split())\nprint(a + b)";
const BUGGY = "a, b = map(int, input().split())\nprint(a * b)";

let usdc;
let commerce;

before(async () => {
  await waitForNode();
  usdc = await deploy("MockUSDC");
  commerce = await deploy("AgenticCommerce", [usdc, 0, account(5).address]);
  await send(deployer, usdc, ERC20.abi, "mint", [CLIENT, 1_000_000_000n]);
});

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

/** Post a job naming the given evaluator and take it through to Submitted. */
async function postJob(code, evaluatorAddress = EVALUATOR) {
  const now = (await publicClient.getBlock()).timestamp;
  const created = await send(client, commerce, AGENTIC_COMMERCE_ABI, "createJob", [
    PROVIDER,
    evaluatorAddress,
    now + 3600n,
    encodeJobDescription({ uri: dataUri(SPEC), hash: hashDocument(SPEC) }),
    "0x0000000000000000000000000000000000000000",
  ]);
  const jobId = BigInt(created.logs[0].topics[1]);
  await send(provider, commerce, AGENTIC_COMMERCE_ABI, "setBudget", [jobId, 1_000_000n, "0x"]);
  await send(client, usdc, ERC20.abi, "approve", [commerce, 1_000_000n]);
  await send(client, commerce, AGENTIC_COMMERCE_ABI, "fund", [jobId, "0x"]);
  const work = deliverable(code);
  await send(provider, commerce, AGENTIC_COMMERCE_ABI, "submit", [
    jobId,
    hashDocument(work),
    encodeDeliverableUri(dataUri(work)),
  ]);
  return jobId;
}

const statusOf = async (jobId) =>
  JOB_STATUS[
    (
      await publicClient.readContract({
        address: commerce,
        abi: AGENTIC_COMMERCE_ABI,
        functionName: "getJob",
        args: [jobId],
      })
    ).status
  ];

const makeEvaluator = () =>
  new Evaluator({
    publicClient,
    wallet: evaluatorWallet,
    jobs: commerce,
    publish: async () => null,
    backend: "process",
  });

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "verdict-state-"));
  return {
    stateFile: new StateFile(join(dir, "state.json")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const acted = (results) => results.filter((r) => !r.skipped);

describe("state file", () => {
  test("round-trips the last block as a bigint", () => {
    const { stateFile, cleanup } = tempState();
    try {
      assert.equal(stateFile.load(), null, "fresh state is empty");
      stateFile.save({ lastBlock: 123_456_789_012n, updatedAt: "2026-09-24T00:00:00.000Z" });
      assert.equal(stateFile.load().lastBlock, 123_456_789_012n);
    } finally {
      cleanup();
    }
  });
});

describe("the evaluator service", () => {
  test("judges and settles work submitted since the last pass", async () => {
    const { stateFile, cleanup } = tempState();
    try {
      const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const good = await postJob(GOOD);
      const bad = await postJob(BUGGY);

      const { results } = await runOnce({
        evaluator: makeEvaluator(),
        publicClient,
        stateFile,
        fromBlock: startBlock,
      });

      assert.deepEqual(
        acted(results).map((r) => [r.jobId, r.outcome]),
        [
          [good, "passed"],
          [bad, "failed"],
        ],
      );
      assert.equal(await statusOf(good), "Completed");
      assert.equal(await statusOf(bad), "Rejected");
    } finally {
      cleanup();
    }
  });

  test("a second pass with nothing new does nothing", async () => {
    const { stateFile, cleanup } = tempState();
    try {
      const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      await postJob(GOOD);
      const ev = makeEvaluator();

      await runOnce({ evaluator: ev, publicClient, stateFile, fromBlock: startBlock });
      const second = await runOnce({ evaluator: ev, publicClient, stateFile, fromBlock: startBlock });

      assert.equal(acted(second.results).length, 0);
    } finally {
      cleanup();
    }
  });

  test("resumes after a restart without re-handling or skipping", async () => {
    const { stateFile, cleanup } = tempState();
    try {
      const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const first = await postJob(GOOD);
      await runOnce({ evaluator: makeEvaluator(), publicClient, stateFile, fromBlock: startBlock });
      assert.equal(await statusOf(first), "Completed");

      // Work arrives while the service is down.
      const whileDown = await postJob(GOOD);

      // A brand-new process with no in-memory record of what it did before.
      const { results } = await runOnce({ evaluator: makeEvaluator(), publicClient, stateFile });

      assert.deepEqual(
        acted(results).map((r) => r.jobId),
        [whileDown],
        "picks up only the job that arrived while down",
      );
      assert.equal(await statusOf(whileDown), "Completed");
    } finally {
      cleanup();
    }
  });

  test("ignores jobs that name a different evaluator", async () => {
    const { stateFile, cleanup } = tempState();
    try {
      const startBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
      const notOurs = await postJob(GOOD, account(9).address);

      const { results } = await runOnce({
        evaluator: makeEvaluator(),
        publicClient,
        stateFile,
        fromBlock: startBlock,
      });

      assert.equal(acted(results).length, 0);
      assert.equal(await statusOf(notOurs), "Submitted", "left for its own evaluator");
    } finally {
      cleanup();
    }
  });

  test("a fresh start without a from-block begins at the head, not at genesis", async () => {
    const { stateFile, cleanup } = tempState();
    try {
      const old = await postJob(GOOD); // before the service ever ran
      // Move the head past the job's block. The head block itself IS scanned on a
      // fresh start — work landing in the block the service starts on must not be
      // lost — so "historical" means strictly before it.
      await publicClient.request({ method: "evm_mine", params: [] });

      const { from, results } = await runOnce({ evaluator: makeEvaluator(), publicClient, stateFile });

      assert.ok(from > 0n, "does not replay the whole chain");
      assert.equal(acted(results).length, 0);
      assert.equal(await statusOf(old), "Submitted", "historical work needs an explicit from-block");
    } finally {
      cleanup();
    }
  });
});
