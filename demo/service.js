/**
 * The product demo: an agent runs code it wrote, and pays per millisecond.
 *
 * No account. No API key. No card. It has a wallet and a budget, and that is
 * the whole relationship.
 *
 *   npm run chain     (one terminal)
 *   npm run demo:service
 */
import { createPublicClient, createWalletClient, http, defineChain, decodeEventLog } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { createService } from "../service/index.js";
import { RatchetClient } from "../src/client.js";
import { formatUsdc } from "../src/usdc.js";
import { VAULT_ABI, VAULT_BYTECODE } from "../src/vault.js";

const RPC_URL = process.env.RATCHET_RPC ?? "http://127.0.0.1:8545";
const IS_LOCAL = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
const PORT = Number(process.env.PORT ?? 4022);
const MNEMONIC = "test test test test test test test test test test test junk";

const localChain = defineChain({
  id: 31337,
  name: "Ratchet Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const chain = IS_LOCAL ? localChain : arcTestnet;

const payerAccount = process.env.RATCHET_PAYER_KEY
  ? privateKeyToAccount(process.env.RATCHET_PAYER_KEY)
  : mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const providerAccount = process.env.RATCHET_PROVIDER_KEY
  ? privateKeyToAccount(process.env.RATCHET_PROVIDER_KEY)
  : mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const payerWallet = createWalletClient({ account: payerAccount, chain, transport: http(RPC_URL) });
const providerWallet = createWalletClient({ account: providerAccount, chain, transport: http(RPC_URL) });

/** The kind of thing an agent actually asks a sandbox to do. */
const TASKS = [
  {
    name: "arithmetic",
    language: "python",
    code: "print(sum(i*i for i in range(10_000)))",
  },
  {
    name: "parse + aggregate",
    language: "python",
    code: `import json
rows = [{"region": r, "n": i} for i, r in enumerate(["emea","apac","us"] * 400)]
agg = {}
for row in rows:
    agg[row["region"]] = agg.get(row["region"], 0) + row["n"]
print(json.dumps(agg, sort_keys=True))`,
  },
  {
    name: "string work (js)",
    language: "javascript",
    code: `const words = "the quick brown fox jumps over the lazy dog".split(" ");
console.log(JSON.stringify(words.map(w => w.split("").reverse().join(""))));`,
  },
  {
    name: "heavier compute",
    language: "python",
    code: `def primes(n):
    sieve = bytearray([1]) * n
    sieve[0:2] = b"\\x00\\x00"
    for i in range(2, int(n**0.5) + 1):
        if sieve[i]:
            sieve[i*i::i] = bytearray(len(sieve[i*i::i]))
    return sum(sieve)
print("primes under 2m:", primes(2_000_000))`,
  },
  {
    name: "code that crashes",
    language: "python",
    code: "raise ValueError('the agent wrote a bug')",
  },
  {
    name: "code that hangs",
    language: "python",
    code: "while True: pass",
    timeoutMs: 1500,
  },
];

const bar = (n = 78) => "─".repeat(n);

async function main() {
  console.log(`\n${bar()}`);
  console.log("  A code sandbox that bills per millisecond, in USDC");
  console.log(bar());

  process.stdout.write("  deploying vault... ");
  const deployHash = await providerWallet.deployContract({
    abi: VAULT_ABI,
    bytecode: VAULT_BYTECODE,
    account: providerAccount,
    chain,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const vault = deployReceipt.contractAddress;
  console.log(vault);

  const startBlock = await publicClient.getBlockNumber();

  const { app, ledger, backend } = await createService({
    vault,
    provider: providerAccount.address,
    chain,
    publicClient,
    wallet: providerWallet,
    settleAt: "0.01",
  });

  const server = await new Promise((r) => {
    const s = app.listen(PORT, () => r(s));
  });
  const base = `http://127.0.0.1:${PORT}`;

  console.log(`  sandbox backend: ${backend}${backend === "process" ? "  (not isolated — dev only)" : "  (isolated)"}`);
  console.log(`  service on ${base}\n`);

  try {
    const agent = new RatchetClient({
      wallet: payerWallet,
      publicClient,
      chain,
      budget: "0.50",
      deposit: "0.50",
    });

    console.log(`  ${"task".padEnd(22)} ${"result".padEnd(26)} ${"time".padStart(9)} ${"cost".padStart(11)}`);
    console.log(`  ${"─".repeat(22)} ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(11)}`);

    for (const task of TASKS) {
      const res = await agent.fetch(`${base}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language: task.language,
          code: task.code,
          timeoutMs: task.timeoutMs ?? 10_000,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        console.log(`  ${task.name.padEnd(22)} ${("HTTP " + res.status).padEnd(26)}`);
        continue;
      }

      const outcome = body.timedOut
        ? "timed out, killed"
        : body.exitCode !== 0
          ? `exit ${body.exitCode}: ${firstLine(body.stderr)}`
          : firstLine(body.stdout);

      console.log(
        `  ${task.name.padEnd(22)} ${truncate(outcome, 26).padEnd(26)} ` +
          `${(body.durationMs + "ms").padStart(9)} ${("$" + body.billing.charged).padStart(11)}`,
      );
    }

    // --- sustained load ---------------------------------------------------
    // Six runs make the one-off channel open look expensive. Real usage is a
    // stream, so run a light task at volume and let the economics settle out.
    const VOLUME = Number(process.env.RATCHET_VOLUME ?? 100);
    process.stdout.write(`\n  now ${VOLUME} runs back to back... `);

    const spentBefore = agent.summary().spent;
    const started = Date.now();

    for (let i = 0; i < VOLUME; i++) {
      const res = await agent.fetch(`${base}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language: "javascript",
          code: `console.log(${i} * 2)`,
          timeoutMs: 5_000,
        }),
      });
      if (!res.ok) throw new Error(`run ${i} failed: ${res.status} ${await res.text()}`);
      await res.json();
    }

    const took = (Date.now() - started) / 1000;
    const volumeSpend = agent.summary().spent - spentBefore;
    console.log(
      `done in ${took.toFixed(1)}s ($${formatUsdc(volumeSpend)}, ` +
        `$${formatUsdc(volumeSpend / BigInt(VOLUME))}/run)`,
    );

    // Let background settlement land, then account for it.
    await new Promise((r) => setTimeout(r, IS_LOCAL ? 2500 : 6000));

    const summary = agent.summary();
    const txs = await vaultTransactions(vault, startBlock);
    const gas = txs.reduce((a, t) => a + t.fee, 0n);

    console.log(`\n${bar()}`);
    console.log(`  agent spent            $${formatUsdc(summary.spent)} across ${summary.calls} runs`);
    console.log(`  average per run        $${formatUsdc(summary.averagePerCall)}`);
    console.log(`  authorised (ceilings)  $${formatUsdc(summary.authorised)}  ← reserved, not spent`);
    console.log(`  never charged          $${formatUsdc(summary.authorised - summary.spent)} of reserved headroom`);
    console.log();
    console.log(`  on-chain transactions  ${txs.length}`);
    for (const t of txs) {
      console.log(`    ${t.label.padEnd(16)} ${String(t.gasUsed).padStart(8)} gas  $${formatUsdc(t.fee, 8)}`);
    }
    console.log(`  gas paid by provider   $${formatUsdc(gas, 8)}`);

    const pct = summary.spent === 0n ? 0 : Number((gas * 1_000_000n) / summary.spent) / 10_000;
    console.log(`  cost of collection     ${pct.toFixed(2)}% of revenue`);

    const state = ledger.all()[0];
    if (state) {
      console.log();
      console.log(`  provider booked        $${formatUsdc(state.owed)}`);
      console.log(`  provider settled       $${formatUsdc(state.settled)} on-chain`);
      console.log(`  unsettled tail         $${formatUsdc(state.owed - state.settled)} (redeemable any time)`);
    }
    console.log(bar() + "\n");

    console.log("  The agent never signed up, never held a gas token, and never");
    console.log("  paid for a second more compute than it used.\n");
  } finally {
    server.close();
  }
}

const firstLine = (s) => (s ?? "").trim().split("\n")[0] || "(no output)";
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function labelFor(events) {
  if (events.includes("Claimed") && events.includes("ChannelClosed")) return "claimAndClose";
  if (events.includes("ChannelClosed")) return "sweep";
  if (events.includes("ChannelOpened")) return "open channel";
  if (events.includes("Claimed")) return "settle voucher";
  return events[0] ?? "unknown";
}

async function vaultTransactions(vault, fromBlock) {
  const logs = await publicClient.getLogs({ address: vault, fromBlock, toBlock: "latest" });
  const byTx = new Map();
  for (const log of logs) {
    let eventName;
    try {
      ({ eventName } = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics }));
    } catch {
      continue;
    }
    const e = byTx.get(log.transactionHash) ?? {
      hash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      events: [],
    };
    e.events.push(eventName);
    byTx.set(log.transactionHash, e);
  }
  const out = [];
  for (const e of [...byTx.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? Number(a.logIndex - b.logIndex)
      : Number(a.blockNumber - b.blockNumber),
  )) {
    const receipt = await publicClient.getTransactionReceipt({ hash: e.hash });
    out.push({
      label: labelFor(e.events),
      gasUsed: receipt.gasUsed,
      fee: receipt.gasUsed * receipt.effectiveGasPrice,
      hash: e.hash,
    });
  }
  return out;
}

main().catch((err) => {
  console.error("\ndemo failed:", err);
  process.exit(1);
});
