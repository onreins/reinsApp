/**
 * Run the Verdict arbiter API.
 *
 *   node --env-file=.env arbiter/server.js
 *
 * Environment:
 *   RATCHET_EVALUATOR_KEY       the key that signs rulings (required)
 *   PORT                        listen port                        (default 4080)
 *   VERDICT_PAID=1              charge per ruling over x402         (default: free)
 *   VERDICT_PRICE               price per ruling                    (default $0.01)
 *   VERDICT_PAY_TO              revenue address                     (default: the evaluator's)
 *   RATCHET_NETWORK             testnet | mainnet, for payments     (default testnet)
 *   VERDICT_RULINGS_DIR         where issued rulings are kept       (default rulings/)
 *   VERDICT_REQUIRE_ISOLATION=1 abstain unless tests ran in Docker  (recommended in production)
 *   VERDICT_RATE_LIMIT          rulings per client IP per minute    (default 60, 0 disables)
 *   VERDICT_TRUST_PROXY=1       read the client IP from X-Forwarded-For (only behind your own proxy)
 *   RATCHET_SANDBOX             force docker | process
 */
import { privateKeyToAccount } from "viem/accounts";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

import { createArbiter, DEFAULT_PRICE } from "./app.js";
import { selectBackend } from "../src/sandbox.js";
import { NETWORKS, FACILITATORS } from "../service/x402.js";

const key = process.env.RATCHET_EVALUATOR_KEY;
if (!key) {
  console.error("\n  RATCHET_EVALUATOR_KEY is not set. Run with --env-file=.env.\n");
  process.exit(1);
}

const account = privateKeyToAccount(key);
const network = process.env.RATCHET_NETWORK ?? "testnet";
const port = Number(process.env.PORT ?? 4080);
const backend = await selectBackend();
const requireIsolation = process.env.VERDICT_REQUIRE_ISOLATION === "1";

let payment = null;
if (process.env.VERDICT_PAID === "1") {
  if (!NETWORKS[network]) {
    console.error(`\n  unknown RATCHET_NETWORK "${network}" (use testnet or mainnet)\n`);
    process.exit(1);
  }
  payment = {
    price: process.env.VERDICT_PRICE ?? DEFAULT_PRICE,
    gateway: createGatewayMiddleware({
      sellerAddress: process.env.VERDICT_PAY_TO ?? account.address,
      networks: NETWORKS[network],
      facilitatorUrl: FACILITATORS[network],
      description: "A signed Verdict ruling",
    }),
  };
}

const { app } = createArbiter({
  account,
  backend,
  requireIsolation,
  rulingsDir: process.env.VERDICT_RULINGS_DIR ?? "rulings",
  rateLimitPerMinute: Number(process.env.VERDICT_RATE_LIMIT ?? 60),
  payment,
});
// Behind a load balancer every request would otherwise share one IP and one rate limit.
if (process.env.VERDICT_TRUST_PROXY === "1") app.set("trust proxy", 1);

app.listen(port, () => {
  console.log(`\n  Verdict arbiter on :${port}`);
  console.log(`  signs as   ${account.address}`);
  console.log(`  sandbox    ${backend}${backend === "docker" ? " (isolated)" : " (NOT isolated: development only)"}`);
  console.log(`  pricing    ${payment ? `${payment.price} per ruling over x402 (${NETWORKS[network]})` : "free"}`);
  if (backend !== "docker" && !requireIsolation) {
    console.log("  warning    untrusted code runs without isolation; set VERDICT_REQUIRE_ISOLATION=1 in production");
  }
  console.log("");
});
