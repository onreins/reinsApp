/**
 * Real cases on Arc testnet, settled by ArbitratedEscrow on rulings from the
 * arbiter API — the integration any escrow protocol would do.
 *
 *   node --env-file=.env demo/live-arbiter.js
 *
 *   1. deploy ArbitratedEscrow once (address saved to deployments/testnet.json)
 *   2. the buyer opens a case: locks USDC against the hash of the tests
 *   3. the seller delivers and commits the hash of the delivery
 *   4. the arbiter API judges it and signs an EIP-712 attestation for this escrow
 *   5. the winning party submits the attestation; the contract verifies it and pays
 *
 * Two cases run: working code (seller paid) and buggy code (buyer refunded).
 * Evidence, with explorer links and the sealed rulings, goes to docs/live-run/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { artifact } from "../scripts/artifact.js";
import { createArbiter } from "../arbiter/app.js";
import { selectBackend } from "../src/sandbox.js";
import { jobSpec, deliverable, hashDocument } from "../evaluator/spec.js";

const EXPLORER = "https://explorer.testnet.arc.io";
const OUT = "docs/live-run";
const DEPLOYMENT_FILE = "deployments/testnet.json";
const AMOUNT = 50_000n; // $0.05 per case
const ESCROW = artifact("ArbitratedEscrow");
const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

for (const k of ["RATCHET_DEPLOYER_KEY", "RATCHET_PROVIDER_KEY", "RATCHET_EVALUATOR_KEY"]) {
  if (!process.env[k]) {
    console.error(`\n  ${k} missing. Run: node --env-file=.env scripts/setup-roles.js\n`);
    process.exit(1);
  }
}

const chain = arcTestnet;
const publicClient = createPublicClient({ chain, transport: http() });
const accounts = {
  buyer: privateKeyToAccount(process.env.RATCHET_DEPLOYER_KEY),
  seller: privateKeyToAccount(process.env.RATCHET_PROVIDER_KEY),
  arbiter: privateKeyToAccount(process.env.RATCHET_EVALUATOR_KEY),
};
const wallets = {
  buyer: createWalletClient({ account: accounts.buyer, chain, transport: http() }),
  seller: createWalletClient({ account: accounts.seller, chain, transport: http() }),
};
const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const USDC = deployment.usdc;

const fmt = (units) => `$${(Number(units) / 1e6).toFixed(4)}`;
const bar = (n = 76) => "─".repeat(n);
const txLink = (h) => `${EXPLORER}/tx/${h}`;

async function send(role, address, abi, functionName, args) {
  const hash = await wallets[role].writeContract({ address, abi, functionName, args, account: accounts[role], chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${txLink(hash)}`);
  return receipt;
}

async function ensureEscrow() {
  const existing = deployment.contracts.arbitratedEscrow;
  if (existing) return existing;
  process.stdout.write("  deploying ArbitratedEscrow… ");
  const hash = await wallets.buyer.deployContract({
    abi: ESCROW.abi,
    bytecode: ESCROW.bytecode,
    args: [USDC],
    account: accounts.buyer,
    chain,
  });
  const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash });
  deployment.contracts.arbitratedEscrow = contractAddress;
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`${contractAddress}\n  ${txLink(hash)}`);
  return contractAddress;
}

const TERMS = jobSpec({
  language: "python",
  timeoutMs: 10_000,
  tests: [
    { name: "reverses a word", stdin: "verdict", expect: { stdout: "tcidrev" } },
    { name: "handles one letter", stdin: "a", expect: { stdout: "a" } },
    { name: "keeps spaces", stdin: "arc net", expect: { stdout: "ten cra" } },
  ],
});

const CASES = [
  { title: "working code", code: "print(input()[::-1])", winner: "seller" },
  { title: "buggy code", code: "print(input().upper()[::-1])", winner: "buyer" },
];

async function runCase(escrow, arbiterBase, c) {
  const work = deliverable(c.code);
  const txs = {};
  console.log(`\n${bar()}\n  ${c.title}\n${bar()}`);

  txs.approve = (await send("buyer", USDC, ERC20, "approve", [escrow, AMOUNT])).transactionHash;
  const deadline = (await publicClient.getBlock()).timestamp + 3600n;
  const opened = await send("buyer", escrow, ESCROW.abi, "open", [
    accounts.seller.address,
    accounts.arbiter.address,
    AMOUNT,
    hashDocument(TERMS),
    deadline,
  ]);
  txs.open = opened.transactionHash;
  const caseId = opened.logs.find((l) => l.address.toLowerCase() === escrow.toLowerCase()).topics[1];
  console.log(`  opened     ${fmt(AMOUNT)} locked   case ${caseId.slice(0, 18)}…`);

  txs.deliver = (await send("seller", escrow, ESCROW.abi, "deliver", [caseId, hashDocument(work)])).transactionHash;
  console.log(`  delivered  ${hashDocument(work).slice(0, 18)}…`);

  const res = await fetch(`${arbiterBase}/v1/rulings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terms: { document: TERMS },
      delivery: { document: work },
      reference: `arbitrated-escrow:${caseId}`,
      attest: { chainId: chain.id, escrow, caseId },
    }),
  });
  if (!res.ok) throw new Error(`arbiter returned HTTP ${res.status}: ${await res.text()}`);
  const ruling = await res.json();
  console.log(`  ruled      ${ruling.verdict.outcome.toUpperCase()} (${ruling.verdict.reason})`);

  const settleArgs = [ruling.attestation.message, ruling.attestation.signature];
  const receipt = await send(c.winner, escrow, ESCROW.abi, "settle", settleArgs);
  txs.settle = receipt.transactionHash;
  // On Arc gas is paid in the same USDC, so a balance delta would understate the
  // payout. Report what the contract sent, and the submitter's gas separately.
  const paid = receipt.logs
    .filter((l) => l.address.toLowerCase() === USDC.toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: ERC20, ...l }).args; } catch { return null; } })
    .find((a) => a && a.to.toLowerCase() === accounts[c.winner].address.toLowerCase())?.value ?? 0n;
  const gas = (receipt.gasUsed * receipt.effectiveGasPrice) / 10n ** 12n; // 18 → 6 decimals
  console.log(`  settled    ${c.winner} paid ${fmt(paid)} by the contract (${c.winner} spent ${fmt(gas)} gas to submit)`);
  console.log(`             ${txLink(txs.settle)}`);

  return { ...c, caseId, txs, ruling, gained: paid, gas };
}

function evidence(escrow, results) {
  const rows = (r) =>
    Object.entries(r.txs)
      .map(([step, h]) => `| \`${step}\` | [\`${h.slice(0, 18)}…\`](${txLink(h)}) |`)
      .join("\n");
  const section = (r) => `## ${r.title}: ${r.ruling.verdict.outcome} (${r.ruling.verdict.reason})

Case \`${r.caseId}\`. The contract ${r.winner === "seller" ? "paid the seller" : "refunded the buyer"} ${fmt(r.gained)}; the ${r.winner} submitted the ruling and paid ${fmt(r.gas)} gas (on Arc, gas is paid in USDC).
Ruling hash \`${r.ruling.hash}\`, saved as [ruling-${r.ruling.hash}.json](ruling-${r.ruling.hash}.json).

| step | transaction |
|---|---|
${rows(r)}
`;
  return `# Arbiter run on Arc testnet

\`ArbitratedEscrow\` at [\`${escrow}\`](${EXPLORER}/address/${escrow}), settled by rulings from the
Verdict arbiter API (\`arbiter/app.js\`), signed by \`${accounts.arbiter.address}\`. Each
ruling carries an EIP-712 attestation that the contract verified on-chain before moving funds.

${results.map(section).join("\n")}`;
}

async function main() {
  console.log(`\n${bar()}\n  Verdict arbiter × ArbitratedEscrow, live on Arc testnet\n${bar()}`);
  console.log(`  buyer      ${accounts.buyer.address}`);
  console.log(`  seller     ${accounts.seller.address}`);
  console.log(`  arbiter    ${accounts.arbiter.address}`);

  const escrow = await ensureEscrow();
  console.log(`  escrow     ${escrow}`);

  const { app } = createArbiter({ account: accounts.arbiter, backend: await selectBackend() });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const arbiterBase = `http://127.0.0.1:${server.address().port}`;

  const results = [];
  try {
    for (const c of CASES) results.push(await runCase(escrow, arbiterBase, c));
  } finally {
    server.close();
  }

  mkdirSync(OUT, { recursive: true });
  for (const r of results) {
    writeFileSync(join(OUT, `ruling-${r.ruling.hash}.json`), `${JSON.stringify(r.ruling, null, 2)}\n`);
  }
  writeFileSync(join(OUT, "ARBITER-RUN.md"), evidence(escrow, results));
  console.log(`\n${bar()}\n  evidence written to ${OUT}/ARBITER-RUN.md\n${bar()}\n`);
}

main().catch((err) => {
  console.error("\n  live-arbiter failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
