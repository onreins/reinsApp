/**
 * Run the sandbox service for real, settled by Circle Gateway.
 *
 *   RATCHET_SELLER_ADDRESS=0x... npm run serve:x402
 *
 * Environment:
 *   RATCHET_SELLER_ADDRESS   wallet that receives revenue (required)
 *   RATCHET_NETWORK          testnet | mainnet   (default: testnet)
 *   RATCHET_FACILITATOR      override Circle's facilitator url
 *   RATCHET_SANDBOX          docker | process    (default: docker when available)
 *   PORT                     default 4020
 *
 * Note there is no private key here. Circle's Gateway batches signed payment
 * authorizations and credits the seller address; the service never holds a key,
 * never signs, and never pays gas. That is the whole appeal of settling through
 * their facilitator rather than running our own channel.
 */
import { createX402Service, NETWORKS } from "./x402.js";
import { rateCard } from "./pricing.js";

const NETWORK = process.env.RATCHET_NETWORK ?? "testnet";
const PORT = Number(process.env.PORT ?? 4020);
const sellerAddress = process.env.RATCHET_SELLER_ADDRESS;

if (!sellerAddress) {
  console.error(
    [
      "",
      "  RATCHET_SELLER_ADDRESS is not set — there is nowhere to send revenue.",
      "",
      "  1. Create a wallet:  npm run keygen",
      "  2. Serve:            RATCHET_SELLER_ADDRESS=0x... npm run serve:x402",
      "",
      "  The seller address only receives. No private key is needed to run this.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(sellerAddress)) {
  console.error(`\n  RATCHET_SELLER_ADDRESS is not a valid address: ${sellerAddress}\n`);
  process.exit(1);
}

if (!NETWORKS[NETWORK]) {
  console.error(`\n  RATCHET_NETWORK must be testnet or mainnet (got "${NETWORK}").\n`);
  process.exit(1);
}

const bar = (n = 68) => "─".repeat(n);

const main = async () => {
  const svc = await createX402Service({
    sellerAddress,
    network: NETWORK,
    facilitatorUrl: process.env.RATCHET_FACILITATOR,
  });

  if (svc.backend !== "docker") {
    console.warn(
      [
        "",
        "  WARNING: the sandbox is running as a bare child process.",
        "  That is NOT a security boundary — submitted code can read the",
        "  filesystem and open sockets. Start Docker before accepting",
        "  untrusted callers, or set RATCHET_SANDBOX=docker to require it.",
        "",
      ].join("\n"),
    );
  }

  const card = rateCard();

  const server = svc.app.listen(PORT, () => {
    console.log(`\n${bar()}`);
    console.log("  Sandboxed code execution, billed per run");
    console.log(bar());
    console.log(`  network     ${svc.network}  (Arc ${NETWORK})`);
    console.log(`  settlement  Circle Gateway Nanopayments — batched, gasless for the payer`);
    console.log(`  facilitator ${svc.facilitator}`);
    console.log(`  revenue to  ${sellerAddress}`);
    console.log(
      `  sandbox     ${svc.backend}${svc.backend === "docker" ? " (isolated)" : " (NOT isolated)"}`,
    );
    console.log(`  price       ${card.base} per run + ${card.perSecond}/second`);
    console.log(`\n  listening on http://0.0.0.0:${PORT}`);
    console.log("    GET  /health    free");
    console.log("    GET  /pricing   free — rate card and payment terms");
    console.log("    POST /v1/run    paid");
    console.log(`${bar()}\n`);
  });

  const shutdown = (signal) => {
    console.log(`\n  ${signal} — closing. Circle settles batched payments independently,`);
    console.log("  so revenue already authorised is not lost by stopping here.");
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err) => {
  console.error("\n  service failed to start:", err.shortMessage ?? err.message);
  process.exit(1);
});
