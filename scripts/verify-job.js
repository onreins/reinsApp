/**
 * Don't trust us — check it.
 *
 *   node scripts/verify-job.js <jobId> [--from-block N] [--network testnet|mainnet]
 *
 * Re-derives a Verdict decision using nothing but the chain:
 *
 *   1. reads the job from AgenticCommerce and decodes the spec from its description
 *   2. finds the provider's submit() transaction and decodes the deliverable from its calldata
 *   3. checks both against the hashes committed on-chain
 *   4. re-runs the tests itself, independently of the evaluator
 *   5. compares that to what the evaluator actually did on-chain
 *   6. if the sealed verdict file is present, checks it hashes to the on-chain
 *      reason and that its signature recovers to the job's evaluator
 *
 * No keys needed. Anyone can run it.
 */
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http, decodeFunctionData, decodeEventLog, verifyMessage } from "viem";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { evaluate, resolve, OUTCOME } from "../evaluator/verify.js";
import {
  parseJobDescription,
  decodeDeliverableUri,
  hashDocument,
  matchesCommitment,
} from "../evaluator/spec.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const jobIdArg = args.find((a, i) => /^\d+$/.test(a) && !String(args[i - 1] ?? "").startsWith("--"));
if (!jobIdArg) {
  console.error("\n  usage: node scripts/verify-job.js <jobId> [--from-block N] [--network testnet]\n");
  process.exit(1);
}

const jobId = BigInt(jobIdArg);
const network = flag("--network") ?? "testnet";
const chain = network === "mainnet" ? arc : arcTestnet;
const deployment = JSON.parse(readFileSync(`deployments/${network}.json`, "utf8"));
const COMMERCE = flag("--commerce") ?? deployment.contracts.agenticCommerce;
const ABI = artifact("AgenticCommerce").abi;
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

/** Arc's public RPC refuses eth_getLogs ranges of 10,000 blocks or more. */
const WINDOW = 9_999n;
const MAX_WINDOWS = 300; // ~17 days at 0.5s blocks; pass --from-block for older jobs

const c = createPublicClient({ chain, transport: http() });

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

/** Find this job's events, scanning backwards in RPC-sized windows. */
async function findEvents() {
  const head = await c.getBlockNumber({ cacheTime: 0 });
  const floor = flag("--from-block") ? BigInt(flag("--from-block")) : 0n;
  const found = {};
  const wanted = ["JobSubmitted", "JobCompleted", "JobRejected"];

  let to = head;
  for (let i = 0; i < MAX_WINDOWS && to >= floor; i += 1) {
    const from = to > WINDOW ? to - WINDOW : 0n;
    const lo = from < floor ? floor : from;
    // Filter by address only and decode locally. Arc's public RPC rejects the
    // OR-of-event-signatures topic filter that getContractEvents builds.
    const logs = await c.getLogs({ address: COMMERCE, fromBlock: lo, toBlock: to });
    for (const log of logs) {
      let ev;
      try {
        ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (ev.args?.jobId !== jobId || !wanted.includes(ev.eventName)) continue;
      if (!found[ev.eventName]) found[ev.eventName] = { ...log, ...ev };
    }
    if (found.JobSubmitted && (found.JobCompleted || found.JobRejected)) break;
    if (lo === 0n) break;
    to = lo - 1n;
  }
  return found;
}

async function main() {
  console.log(`\n  Verifying job #${jobId} on ${chain.name}`);
  console.log(`  AgenticCommerce ${COMMERCE}\n`);

  // --- 1. the job and its spec ---------------------------------------------
  const job = await c.readContract({ address: COMMERCE, abi: ABI, functionName: "getJob", args: [jobId] });
  if (job.client === "0x0000000000000000000000000000000000000000") {
    console.error(`  job #${jobId} does not exist\n`);
    process.exit(1);
  }
  const status = STATUS[job.status];
  console.log(`  client     ${job.client}`);
  console.log(`  provider   ${job.provider}`);
  console.log(`  evaluator  ${job.evaluator}`);
  console.log(`  status     ${status}\n`);

  check(
    job.client.toLowerCase() !== job.evaluator.toLowerCase(),
    "evaluator is not the client (no self-evaluation)",
  );

  const pointer = parseJobDescription(job.description);
  const specDoc = await resolve(pointer.uri);
  check(
    matchesCommitment(specDoc, pointer.hash),
    "spec matches the hash committed in the job",
    `${pointer.hash.slice(0, 18)}…`,
  );

  // --- 2. the deliverable, from calldata ------------------------------------
  const events = await findEvents();
  if (!check(Boolean(events.JobSubmitted), "found the provider's submit() transaction")) {
    console.error("\n  could not locate submit(); try --from-block <block before the job was posted>\n");
    process.exit(1);
  }

  const committed = await c.readContract({
    address: COMMERCE,
    abi: ABI,
    functionName: "deliverableOf",
    args: [jobId],
  });
  const submitTx = await c.getTransaction({ hash: events.JobSubmitted.transactionHash });
  const { args: submitArgs } = decodeFunctionData({ abi: ABI, data: submitTx.input });
  const deliverableUri = decodeDeliverableUri(submitArgs[2]);
  const deliverableDoc = await resolve(deliverableUri);
  check(
    matchesCommitment(deliverableDoc, committed),
    "deliverable matches the hash the provider committed",
    `${committed.slice(0, 18)}…`,
  );

  // --- 3. re-run it ourselves ----------------------------------------------
  console.log("\n  re-running the tests independently…");
  const mine = await evaluate({
    specUri: pointer.uri,
    specHash: pointer.hash,
    deliverableUri,
    deliverableHash: committed,
    jobId: jobId.toString(),
  });
  for (const t of mine.tests) {
    console.log(`    ${t.passed ? "pass" : "FAIL"}  ${t.name}${t.passed ? "" : ` — ${t.reasons[0]}`}`);
  }
  console.log(`  independent result: ${mine.outcome.toUpperCase()} (${mine.reason})\n`);

  // --- 4. compare to what actually happened ----------------------------------
  const expected =
    mine.outcome === OUTCOME.PASSED ? "Completed" : mine.outcome === OUTCOME.FAILED ? "Rejected" : "Submitted";
  check(
    status === expected || (expected === "Rejected" && status === "Expired"),
    "the evaluator's on-chain decision matches the independent re-run",
    `expected ${expected}, chain says ${status}`,
  );

  const terminal = events.JobCompleted ?? events.JobRejected;
  if (terminal) {
    const reason = terminal.args.reason;
    const actor = terminal.eventName === "JobCompleted" ? terminal.args.evaluator : terminal.args.rejector;
    check(actor.toLowerCase() === job.evaluator.toLowerCase(), "the decision was made by the named evaluator");

    // --- 5. the published verdict, if we have it ----------------------------
    const file = `docs/live-run/verdict-${reason}.json`;
    if (existsSync(file)) {
      const sealed = JSON.parse(readFileSync(file, "utf8"));
      check(
        hashDocument(sealed.verdict) === reason,
        "published verdict hashes to the on-chain reason",
        `${reason.slice(0, 18)}…`,
      );
      const signed = await verifyMessage({
        address: job.evaluator,
        message: { raw: reason },
        signature: sealed.signature,
      });
      check(signed, "verdict signature recovers to the evaluator");
    } else {
      console.log(`  · no local copy of verdict ${reason.slice(0, 18)}… to check against`);
    }
  }

  console.log(failures === 0 ? "\n  VERIFIED — every check passed.\n" : `\n  ${failures} CHECK(S) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  verification errored:", err.shortMessage ?? err.message);
  process.exit(2);
});
