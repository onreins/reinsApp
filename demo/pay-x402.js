/**
 * An agent paying for compute through Circle Gateway, end to end, on Arc testnet.
 *
 *   node --env-file=.env demo/pay-x402.js
 *
 * The seller is the sandbox service (revenue to the provider address). The buyer
 * is an agent holding the client key. No account, no API key, no card:
 *
 *   1. the agent deposits a little USDC into Circle Gateway (once)
 *   2. it calls the paid endpoint, gets a 402, signs an offchain authorization,
 *      and retries — Circle's GatewayClient.pay() does the whole exchange
 *   3. Circle's facilitator verifies the payment and batches it for settlement,
 *      so the agent pays no gas per call
 *
 * Testnet only. Moves at most DEPOSIT of the client's testnet USDC into Gateway.
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

import { createX402Service } from "../service/x402.js";

const DEPOSIT = "1"; // USDC, deposited only if the Gateway balance is below MIN
const MIN_AVAILABLE = 100_000n; // $0.10 in 6dp units
const PORT = Number(process.env.PORT ?? 4077);

for (const k of ["RATCHET_DEPLOYER_KEY", "RATCHET_PROVIDER_KEY"]) {
  if (!process.env[k]) {
    console.error(`\n  ${k} missing. Run with --env-file=.env (and scripts/setup-roles.js).\n`);
    process.exit(1);
  }
}
if ((process.env.RATCHET_NETWORK ?? "testnet") !== "testnet") {
  console.error("\n  pay-x402 is testnet-only.\n");
  process.exit(1);
}

const seller = privateKeyToAccount(process.env.RATCHET_PROVIDER_KEY).address;
const bar = (n = 72) => "─".repeat(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TASKS = [
  { language: "python", code: "print(sum(range(1_000_000)))", timeoutMs: 3000 },
  { language: "javascript", code: "console.log([3,1,2].sort().join(','))", timeoutMs: 2000 },
  { language: "python", code: "import json; print(json.dumps({'ok': True}))", timeoutMs: 2000 },
];

async function main() {
  console.log(`\n${bar()}\n  An agent buys compute through Circle Gateway on Arc testnet\n${bar()}`);

  // --- the seller ------------------------------------------------------------
  const svc = await createX402Service({ sellerAddress: seller, network: "testnet", backend: "process" });
  const server = await new Promise((r) => {
    const s = svc.app.listen(PORT, () => r(s));
  });
  const url = `http://127.0.0.1:${PORT}/v1/run`;
  console.log(`  seller      ${seller}  (service on :${PORT})`);

  try {
    // --- the buyer ----------------------------------------------------------
    const agent = new GatewayClient({
      chain: "arcTestnet",
      privateKey: process.env.RATCHET_DEPLOYER_KEY,
    });
    const buyer = privateKeyToAccount(process.env.RATCHET_DEPLOYER_KEY).address;
    console.log(`  buyer       ${buyer}`);

    let balances = await agent.getBalances();
    console.log(`  wallet      $${balances.wallet.formatted} USDC`);
    console.log(`  gateway     $${balances.gateway.formattedAvailable} available`);

    if (balances.gateway.available < MIN_AVAILABLE) {
      process.stdout.write(`\n  depositing $${DEPOSIT} into Gateway... `);
      const dep = await agent.deposit(DEPOSIT);
      console.log(`done  (${dep.depositTxHash})`);

      // Gateway credits deposits once they are final; poll rather than assume.
      for (let i = 0; i < 60; i += 1) {
        balances = await agent.getBalances();
        if (balances.gateway.available >= MIN_AVAILABLE) break;
        await sleep(5000);
      }
      console.log(`  gateway     $${balances.gateway.formattedAvailable} available`);
      if (balances.gateway.available < MIN_AVAILABLE) {
        throw new Error("deposit not yet credited by Gateway — rerun in a minute");
      }
    }

    const sellerBefore = await agent.getBalances(seller);

    // --- pay for work ---------------------------------------------------------
    console.log(`\n  paying for ${TASKS.length} runs:\n`);
    let spent = 0n;
    for (const task of TASKS) {
      const res = await agent.pay(url, { method: "POST", body: task });
      spent += res.amount;
      const out = String(res.data?.stdout ?? "").trim().split("\n")[0];
      console.log(
        `    ${task.language.padEnd(10)} -> ${out.padEnd(22)}  paid $${res.formattedAmount}  ` +
          `(ran ${res.data?.durationMs}ms, http ${res.status})`,
      );
    }

    const after = await agent.getBalances();
    const sellerAfter = await agent.getBalances(seller);

    console.log(`\n${bar()}`);
    console.log(`  agent spent            $${(Number(spent) / 1e6).toFixed(6)} across ${TASKS.length} runs`);
    console.log("  agent gas per call     $0 — Circle batches the authorizations");
    console.log(`  agent gateway balance  $${after.gateway.formattedAvailable}`);
    console.log(
      `  seller gateway total   $${sellerBefore.gateway.formattedTotal} -> $${sellerAfter.gateway.formattedTotal}` +
        "  (credited once Circle settles the batch)",
    );
    console.log(bar());
    console.log("  No account, no API key, no card. A wallet and a budget.\n");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\n  pay-x402 failed:", err.shortMessage ?? err.message);
  if (err.cause) console.error("  cause:", err.cause.message ?? err.cause);
  process.exit(1);
});
