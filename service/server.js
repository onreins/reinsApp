/**
 * Run the sandbox service for real.
 *
 *   RATCHET_PROVIDER_KEY=0x... RATCHET_VAULT=0x... npm run serve
 *
 * Environment:
 *   RATCHET_PROVIDER_KEY  wallet that receives revenue and pays settlement gas (required)
 *   RATCHET_VAULT         deployed RatchetVault address (required)
 *   RATCHET_NETWORK       mainnet | testnet    (default: testnet)
 *   RATCHET_RPC           override the RPC url
 *   RATCHET_SETTLE_AT     accrued USDC that triggers settlement (default: 0.25)
 *   RATCHET_SANDBOX       docker | process     (default: docker when available)
 *   PORT                  default 4020
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { createService } from "./index.js";
import { settleAll } from "../src/server.js";
import { formatUsdc } from "../src/usdc.js";

const NETWORK = process.env.RATCHET_NETWORK ?? "testnet";
const chain = NETWORK === "mainnet" ? arc : arcTestnet;
const PORT = Number(process.env.PORT ?? 4020);

const required = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  ${name} is required. See the header of service/server.js.\n`);
    process.exit(1);
  }
  return v;
};

const account = privateKeyToAccount(required("RATCHET_PROVIDER_KEY"));
const vault = required("RATCHET_VAULT");
const rpcUrl = process.env.RATCHET_RPC ?? chain.rpcUrls.default.http[0];

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const main = async () => {
  const balance = await publicClient.getBalance({ address: account.address });

  const { app, ledger, backend } = await createService({
    vault,
    provider: account.address,
    chain,
    publicClient,
    wallet,
    settleAt: process.env.RATCHET_SETTLE_AT ?? "0.25",
  });

  if (backend !== "docker") {
    console.warn(
      "\n  WARNING: the sandbox is running as a bare child process.\n" +
        "  That is NOT a security boundary — submitted code can read the filesystem\n" +
        "  and open sockets. Start Docker before accepting untrusted callers.\n",
    );
  }

  const server = app.listen(PORT, () => {
    console.log(`\n  sandbox service`);
    console.log(`  network   ${chain.name} (${chain.id})`);
    console.log(`  provider  ${account.address}  ($${formatUsdc(balance)} for gas)`);
    console.log(`  vault     ${vault}`);
    console.log(`  sandbox   ${backend}`);
    console.log(`  listening on http://0.0.0.0:${PORT}\n`);
  });

  // Redeem outstanding vouchers before going down, so a restart does not
  // strand revenue in the in-memory ledger.
  const shutdown = async (signal) => {
    console.log(`\n  ${signal} — settling outstanding vouchers before exit...`);
    server.close();
    try {
      const results = await settleAll({ ledger, wallet, publicClient, vault });
      const ok = results.filter((r) => r.ok).length;
      console.log(`  settled ${ok}/${results.length} channel(s).`);
    } catch (err) {
      console.error("  settlement on shutdown failed:", err.shortMessage ?? err.message);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((err) => {
  console.error("\n  service failed to start:", err.shortMessage ?? err.message);
  process.exit(1);
});
