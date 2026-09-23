/**
 * The evaluator, end to end.
 *
 * Three jobs, each exercising one of the outcomes that matter:
 *
 *   1. honest provider     -> tests pass    -> escrow released
 *   2. buggy provider      -> tests fail    -> escrow refused, client refunded
 *   3. cheating provider   -> content swap  -> evaluator abstains, escrow untouched
 *
 * Then the ERC-8004 path: an independent validation score posted on-chain.
 *
 *   npm run chain      (one terminal)
 *   npm run demo:verdict
 */
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { ContentStore } from "../evaluator/store.js";
import { Evaluator, OUTCOME } from "../evaluator/index.js";
import {
  jobSpec,
  deliverable,
  encodeJobDescription,
  encodeDeliverableUri,
  hashDocument,
} from "../evaluator/spec.js";
import { AGENTIC_COMMERCE_ABI, VALIDATION_REGISTRY_ABI, JOB_STATUS } from "../evaluator/abi.js";
import { artifact } from "../scripts/artifact.js";

const RPC = process.env.RATCHET_RPC ?? "http://127.0.0.1:8545";
const M = "test test test test test test test test test test test junk";

const chain = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const accounts = {
  deployer: mnemonicToAccount(M, { addressIndex: 0 }),
  client: mnemonicToAccount(M, { addressIndex: 1 }),
  provider: mnemonicToAccount(M, { addressIndex: 2 }),
  evaluator: mnemonicToAccount(M, { addressIndex: 3 }),
};

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const w = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });

const USDC = (n) => BigInt(Math.round(n * 1e6)); // the ERC-20 view: 6 decimals
const fmt = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
const bar = (n = 78) => "─".repeat(n);

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await w(accounts.deployer).deployContract({
    abi,
    bytecode,
    args,
    account: accounts.deployer,
    chain,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return r.contractAddress;
}

const send = async (account, address, abi, functionName, args) => {
  const hash = await w(account).writeContract({ address, abi, functionName, args, account, chain });
  return publicClient.waitForTransactionReceipt({ hash });
};

// The tests the work must pass. Agreed before any work starts.
const SPEC = jobSpec({
  language: "python",
  timeoutMs: 10_000,
  tests: [
    { name: "adds two numbers", stdin: "2 3", expect: { stdout: "5" } },
    { name: "handles zero", stdin: "0 0", expect: { stdout: "0" } },
    { name: "handles negatives", stdin: "-4 2", expect: { stdout: "-2" } },
  ],
});

const GOOD = `a, b = map(int, input().split())
print(a + b)`;

const BUGGY = `a, b = map(int, input().split())
print(a * b)   # wrong operator`;

async function main() {
  console.log(`\n${bar()}`);
  console.log("  Verdict — a neutral evaluator for ERC-8183 agent jobs");
  console.log(bar());

  const store = new ContentStore();
  const storeUrl = await store.listen();

  const usdc = await deploy("MockUSDC");
  const jobs = await deploy("MockAgenticCommerce", [usdc]);
  const validation = await deploy("MockValidationRegistry");

  console.log(`  job contract   ${jobs}`);
  console.log(`  validation     ${validation}`);
  console.log(`  document store ${storeUrl}`);
  console.log(`  evaluator      ${accounts.evaluator.address}\n`);

  await send(accounts.deployer, usdc, artifact("MockUSDC").abi, "mint", [
    accounts.client.address,
    USDC(1000),
  ]);

  const specDoc = store.put(SPEC);
  const description = encodeJobDescription({
    uri: specDoc.uri,
    hash: specDoc.hash,
    summary: "sum two integers from stdin",
  });

  const evaluator = new Evaluator({
    publicClient,
    wallet: w(accounts.evaluator),
    jobs,
    validation,
    publish: store.publisher(),
    backend: "process",
  });

  const scenarios = [
    { title: "1. honest provider", code: GOOD, tamper: null, budget: 10 },
    { title: "2. buggy provider", code: BUGGY, tamper: null, budget: 10 },
    {
      title: "3. provider swaps the code after committing",
      code: GOOD,
      tamper: BUGGY,
      budget: 10,
    },
  ];

  for (const s of scenarios) {
    console.log(bar());
    console.log(`  ${s.title}`);
    console.log(bar());

    // --- client posts the job ------------------------------------------
    // Deadlines come from the chain's clock, not ours. A local node that has
    // fast-forwarded blocks is hours ahead of wall time, and on Arc proper the
    // timestamp is only guaranteed non-decreasing anyway.
    const now = (await publicClient.getBlock()).timestamp;
    const expiredAt = now + 3600n;
    const receipt = await send(accounts.client, jobs, AGENTIC_COMMERCE_ABI, "createJob", [
      accounts.provider.address,
      accounts.evaluator.address,
      expiredAt,
      description,
      "0x0000000000000000000000000000000000000000",
    ]);
    const jobId = BigInt(receipt.logs[0].topics[1]);

    // --- provider quotes, client escrows --------------------------------
    await send(accounts.provider, jobs, AGENTIC_COMMERCE_ABI, "setBudget", [
      jobId,
      USDC(s.budget),
      "0x",
    ]);
    await send(accounts.client, usdc, artifact("MockUSDC").abi, "approve", [jobs, USDC(s.budget)]);
    await send(accounts.client, jobs, AGENTIC_COMMERCE_ABI, "fund", [jobId, "0x"]);
    console.log(`  job #${jobId} funded with ${fmt(USDC(s.budget))}`);

    // --- provider submits -----------------------------------------------
    const work = deliverable(s.code);
    const doc = store.put(work);
    await send(accounts.provider, jobs, AGENTIC_COMMERCE_ABI, "submit", [
      jobId,
      doc.hash,
      encodeDeliverableUri(doc.uri),
    ]);
    console.log(`  provider committed to ${doc.hash.slice(0, 18)}…`);

    if (s.tamper) {
      // Serve different content than was committed to on-chain.
      store.tamper(doc.hash, deliverable(s.tamper));
      console.log(`  ...then quietly swapped what that hash serves`);
    }

    // --- evaluate ---------------------------------------------------------
    const before = {
      provider: await balance(usdc, accounts.provider.address),
      client: await balance(usdc, accounts.client.address),
    };

    const result = await evaluator.handleJob(jobId);
    const v = result.verdict;

    console.log(`\n  verdict: ${v.outcome.toUpperCase()}  (${v.reason})`);
    for (const t of v.tests ?? []) {
      console.log(`    ${t.passed ? "pass" : "FAIL"}  ${t.name}${t.passed ? "" : ` — ${t.reasons[0]}`}`);
    }

    const job = await publicClient.readContract({
      address: jobs,
      abi: AGENTIC_COMMERCE_ABI,
      functionName: "getJob",
      args: [jobId],
    });

    // Rejected escrow only returns on the client's own claim.
    if (JOB_STATUS[job.status] === "Rejected") {
      await send(accounts.client, jobs, AGENTIC_COMMERCE_ABI, "claimRefund", [jobId]);
    }

    const after = {
      provider: await balance(usdc, accounts.provider.address),
      client: await balance(usdc, accounts.client.address),
    };

    console.log(`\n  job status     ${JOB_STATUS[job.status]}`);
    console.log(`  provider       ${delta(before.provider, after.provider)}`);
    console.log(`  client         ${delta(before.client, after.client)}`);
    if (v.outcome === OUTCOME.ABSTAIN) {
      console.log(`  escrow untouched — the evaluator refused to take a side.`);
      console.log(`  the job expires and the client reclaims it without anyone judging.`);
    }
    console.log();
  }

  // --- ERC-8004: independent validation ------------------------------------
  console.log(bar());
  console.log("  4. ERC-8004 validation request (independent scoring)");
  console.log(bar());

  const work = deliverable(BUGGY);
  const workDoc = store.put(work);
  const request = store.put({
    specUri: specDoc.uri,
    specHash: specDoc.hash,
    deliverableUri: workDoc.uri,
    deliverableHash: workDoc.hash,
  });

  await send(accounts.client, validation, VALIDATION_REGISTRY_ABI, "validationRequest", [
    accounts.evaluator.address,
    42n, // agent id
    request.uri,
    request.hash,
  ]);
  console.log(`  agent #42 asked ${accounts.evaluator.address.slice(0, 10)}… to validate its work`);

  const val = await evaluator.handleValidationRequest(request.hash, { requestUri: request.uri });

  const status = await publicClient.readContract({
    address: validation,
    abi: VALIDATION_REGISTRY_ABI,
    functionName: "getValidationStatus",
    args: [request.hash],
  });

  console.log(`  verdict        ${val.verdict.outcome} — ${val.verdict.reason}`);
  console.log(`  on-chain score ${status[2]}/100  (recorded by the validator, not the agent)`);
  console.log(`  receipt hash   ${status[3].slice(0, 18)}…`);

  console.log(`\n${bar()}`);
  console.log("  Every verdict is published in full and signed, so either party");
  console.log("  can re-run it and check. When the evaluator cannot verify, it");
  console.log("  abstains rather than guessing.");
  console.log(bar() + "\n");

  store.close();
}

const balance = (usdc, address) =>
  publicClient.readContract({
    address: usdc,
    abi: artifact("MockUSDC").abi,
    functionName: "balanceOf",
    args: [address],
  });

function delta(before, after) {
  const d = after - before;
  if (d === 0n) return `unchanged (${fmt(after)})`;
  return `${d > 0n ? "+" : "-"}${fmt(d < 0n ? -d : d)}  ->  ${fmt(after)}`;
}

main().catch((err) => {
  console.error("\ndemo failed:", err);
  process.exit(1);
});
