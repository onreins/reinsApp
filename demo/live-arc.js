/**
 * A real, verified ERC-8183 job on Arc testnet.
 *
 *   node --env-file=.env demo/live-arc.js
 *
 * Three distinct parties on the live AgenticCommerce contract:
 *
 *   client     escrows USDC for a job with a machine-checkable spec
 *   provider   delivers code and commits its hash on-chain
 *   evaluator  Verdict — re-runs the code against the spec, then pays or refuses
 *
 * Two jobs run: one with correct code (escrow released) and one with a bug
 * (escrow refused, client refunded).
 *
 * Everything the evaluator needs is embedded in the transactions themselves.
 * The spec rides in the job description and the deliverable in `submit`'s
 * optParams, both as content-addressed `data:` URIs. No server of ours has to
 * stay up for anyone to re-derive the verdict: fetch the transactions, decode
 * the URIs, check the hashes, re-run the tests.
 *
 * Results are written to docs/live-run/ — the sealed verdicts, whose hashes are
 * the `reason` committed on-chain, and a LIVE-RUN.md index with explorer links.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { Evaluator, OUTCOME } from "../evaluator/index.js";
import {
  jobSpec,
  deliverable,
  hashDocument,
  canonicalize,
  encodeJobDescription,
  encodeDeliverableUri,
} from "../evaluator/spec.js";
import { AGENTIC_COMMERCE_ABI, JOB_STATUS } from "../evaluator/abi.js";

const EXPLORER = "https://explorer.testnet.arc.io";
const OUT = "docs/live-run";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

for (const k of ["RATCHET_DEPLOYER_KEY", "RATCHET_PROVIDER_KEY", "RATCHET_EVALUATOR_KEY"]) {
  if (!process.env[k]) {
    console.error(`\n  ${k} missing. Run: node --env-file=.env scripts/setup-roles.js\n`);
    process.exit(1);
  }
}

const deployment = JSON.parse(readFileSync("deployments/testnet.json", "utf8"));
const COMMERCE = deployment.contracts.agenticCommerce;
const USDC = deployment.usdc;

const chain = arcTestnet;
const publicClient = createPublicClient({ chain, transport: http() });
const accounts = {
  client: privateKeyToAccount(process.env.RATCHET_DEPLOYER_KEY),
  provider: privateKeyToAccount(process.env.RATCHET_PROVIDER_KEY),
  evaluator: privateKeyToAccount(process.env.RATCHET_EVALUATOR_KEY),
};
const wallets = Object.fromEntries(
  Object.entries(accounts).map(([k, a]) => [
    k,
    createWalletClient({ account: a, chain, transport: http() }),
  ]),
);

const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

/** $0.10 per job, in USDC's 6-decimal ERC-20 units. */
const BUDGET = 100_000n;
const fmt = (units) => `$${(Number(units) / 1e6).toFixed(4)}`;
const bar = (n = 76) => "─".repeat(n);
const txLink = (h) => `${EXPLORER}/tx/${h}`;

/** Content-addressed data: URI — the document travels with its own hash check. */
const dataUri = (doc) =>
  `data:application/json;base64,${Buffer.from(canonicalize(doc)).toString("base64")}`;

async function send(role, address, abi, functionName, args) {
  const hash = await wallets[role].writeContract({
    address,
    abi,
    functionName,
    args,
    account: accounts[role],
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${txLink(hash)}`);
  return receipt;
}

const usdcOf = (address) =>
  publicClient.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [address] });

// ---------------------------------------------------------------------------
// The work being bought
// ---------------------------------------------------------------------------

const SPEC = jobSpec({
  language: "python",
  timeoutMs: 10_000,
  tests: [
    { name: "adds two numbers", stdin: "2 3", expect: { stdout: "5" } },
    { name: "handles zero", stdin: "0 0", expect: { stdout: "0" } },
    { name: "handles negatives", stdin: "-4 2", expect: { stdout: "-2" } },
  ],
});

const JOBS = [
  { title: "correct implementation", code: "a, b = map(int, input().split())\nprint(a + b)" },
  { title: "buggy implementation", code: "a, b = map(int, input().split())\nprint(a * b)" },
];

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });

  console.log(`\n${bar()}`);
  console.log("  Verdict — live on Arc testnet");
  console.log(bar());
  console.log(`  AgenticCommerce  ${COMMERCE}`);
  for (const [role, a] of Object.entries(accounts)) {
    console.log(`  ${role.padEnd(16)} ${a.address}`);
  }

  const specUri = dataUri(SPEC);
  const specHash = hashDocument(SPEC);
  const description = encodeJobDescription({
    uri: specUri,
    hash: specHash,
    summary: "sum two integers read from stdin",
  });

  // Publishing a verdict = writing the sealed document where anyone can read it.
  // Its hash is what goes on-chain as the complete()/reject() reason.
  const publish = async (sealed) => {
    const file = join(OUT, `verdict-${sealed.hash}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ hash: sealed.hash, signature: sealed.signature, verdict: sealed.verdict }, null, 2)}\n`,
    );
    return file.replaceAll("\\", "/");
  };

  const evaluator = new Evaluator({
    publicClient,
    wallet: wallets.evaluator,
    jobs: COMMERCE,
    publish,
    backend: "process",
  });

  const record = [];

  for (const job of JOBS) {
    console.log(`\n${bar()}\n  ${job.title}\n${bar()}`);
    const txs = {};

    // --- client posts ------------------------------------------------------
    const now = (await publicClient.getBlock()).timestamp;
    const created = await send("client", COMMERCE, AGENTIC_COMMERCE_ABI, "createJob", [
      accounts.provider.address,
      accounts.evaluator.address,
      now + 3600n,
      description,
      "0x0000000000000000000000000000000000000000",
    ]);
    txs.createJob = created.transactionHash;
    const createdLog = created.logs.find((l) => l.address.toLowerCase() === COMMERCE.toLowerCase());
    const jobId = decodeEventLog({
      abi: AGENTIC_COMMERCE_ABI,
      data: createdLog.data,
      topics: createdLog.topics,
    }).args.jobId;
    console.log(`  job #${jobId} posted`);

    // --- provider quotes, client escrows -----------------------------------
    txs.setBudget = (
      await send("provider", COMMERCE, AGENTIC_COMMERCE_ABI, "setBudget", [jobId, BUDGET, "0x"])
    ).transactionHash;
    txs.approve = (await send("client", USDC, ERC20, "approve", [COMMERCE, BUDGET])).transactionHash;
    txs.fund = (
      await send("client", COMMERCE, AGENTIC_COMMERCE_ABI, "fund", [jobId, "0x"])
    ).transactionHash;
    console.log(`  escrowed ${fmt(BUDGET)}`);

    // --- provider delivers --------------------------------------------------
    const work = deliverable(job.code);
    const workHash = hashDocument(work);
    const submitted = await send("provider", COMMERCE, AGENTIC_COMMERCE_ABI, "submit", [
      jobId,
      workHash,
      encodeDeliverableUri(dataUri(work)),
    ]);
    txs.submit = submitted.transactionHash;
    console.log(`  delivered, committed ${workHash.slice(0, 18)}…`);

    // --- Verdict evaluates --------------------------------------------------
    const providerBefore = await usdcOf(accounts.provider.address);
    const clientBefore = await usdcOf(accounts.client.address);

    const result = await evaluator.handleJob(jobId, { fromBlock: submitted.blockNumber });
    if (!result.verdict) throw new Error(`evaluator did not judge job ${jobId}: ${result.skipped}`);
    txs[result.outcome === OUTCOME.PASSED ? "complete" : "reject"] = result.txHash;

    const v = result.verdict;
    console.log(`\n  verdict: ${v.outcome.toUpperCase()} (${v.reason})`);
    for (const t of v.tests) {
      console.log(`    ${t.passed ? "pass" : "FAIL"}  ${t.name}${t.passed ? "" : ` — ${t.reasons[0]}`}`);
    }

    // --- refunds are pulled, not pushed -------------------------------------
    const status = JOB_STATUS[
      (
        await publicClient.readContract({
          address: COMMERCE,
          abi: AGENTIC_COMMERCE_ABI,
          functionName: "getJob",
          args: [jobId],
        })
      ).status
    ];
    if (status === "Rejected") {
      txs.claimRefund = (
        await send("client", COMMERCE, AGENTIC_COMMERCE_ABI, "claimRefund", [jobId])
      ).transactionHash;
    }

    const providerDelta = (await usdcOf(accounts.provider.address)) - providerBefore;
    const clientDelta = (await usdcOf(accounts.client.address)) - clientBefore;

    console.log(`\n  status    ${status}${status === "Rejected" ? " -> refunded" : ""}`);
    console.log(`  provider  ${providerDelta > 0n ? "+" : ""}${fmt(providerDelta)}`);
    console.log(`  client    ${clientDelta > 0n ? "+" : ""}${fmt(clientDelta)}  (net of refund gas)`);

    record.push({
      jobId,
      title: job.title,
      outcome: v.outcome,
      reason: v.reason,
      status,
      txs,
      verdictFile: result.uri,
    });
  }

  // --- index -------------------------------------------------------------
  const lines = [
    "# Live run on Arc testnet",
    "",
    `Run at ${new Date().toISOString()} against [AgenticCommerce](${EXPLORER}/address/${COMMERCE}) on Arc testnet (chain ${chain.id}).`,
    "",
    "Three distinct keys play client, provider and evaluator. The job spec lives in the",
    "job's on-chain description and the deliverable in `submit`'s calldata, both as",
    "content-addressed `data:` URIs, so the verdict can be re-derived from the chain alone.",
    "Each verdict file's hash is the `reason` committed on-chain by `complete`/`reject`.",
    "",
    "| party | address |",
    "|---|---|",
    ...Object.entries(accounts).map(
      ([r, a]) => `| ${r} | [\`${a.address}\`](${EXPLORER}/address/${a.address}) |`,
    ),
    "",
  ];
  for (const r of record) {
    lines.push(
      `## Job #${r.jobId} — ${r.title}`,
      "",
      `**${r.outcome.toUpperCase()}** — ${r.reason}. Final status: \`${r.status}\`.`,
      "",
      "| step | transaction |",
      "|---|---|",
    );
    for (const [step, h] of Object.entries(r.txs)) {
      if (h) lines.push(`| \`${step}\` | [\`${h.slice(0, 18)}…\`](${txLink(h)}) |`);
    }
    lines.push("", `Sealed verdict: [\`${r.verdictFile}\`](../../${r.verdictFile})`, "");
  }
  writeFileSync(join(OUT, "LIVE-RUN.md"), `${lines.join("\n")}\n`);

  const left = await publicClient.getBalance({ address: accounts.client.address });
  console.log(`\n${bar()}`);
  console.log(`  recorded in ${OUT}/LIVE-RUN.md`);
  console.log(`  client balance remaining: $${(Number(left) / 1e18).toFixed(4)}`);
  console.log(`${bar()}\n`);
}

main().catch((err) => {
  console.error("\n  live run failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
