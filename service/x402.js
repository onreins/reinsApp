/**
 * The sandbox service, settled through Circle Gateway Nanopayments.
 *
 * This is the Arc-native path and the one that should ship. Circle's Gateway
 * batches signed offchain EIP-3009 authorizations into a single onchain
 * settlement, so per-call economics work without us operating a payment
 * channel — and the payer spends no gas at all, because Circle covers it.
 *
 * We previously did this ourselves in `src/server.js` with Ratchet payment
 * channels. That still works and still demonstrates the mechanism, but
 * Circle's own infrastructure does the same job with a hosted facilitator and
 * compliance screening included. Competing with the platform's payment layer
 * was never the differentiator; verifying that work was actually done is.
 *
 * ## The billing tradeoff, stated plainly
 *
 * Ratchet could bill for milliseconds *actually used*, because the voucher
 * authorised a ceiling and we booked the real figure afterwards. x402 is
 * pay-before: the price is fixed at the moment the 402 is issued.
 *
 * So here the caller is quoted from the timeout they request, and they control
 * that number. Ask for 1s, pay for 1s. It is a slightly worse deal than
 * measured billing for a caller who over-provisions, and a far better one than
 * any subscription. The response still reports the actual duration and what it
 * would have cost, so a caller can tune their timeout down.
 */
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

import { run, selectBackend, SandboxError, LANGUAGES } from "../src/sandbox.js";
import { PRICING, costOf, clampTimeout, rateCard } from "./pricing.js";
import { formatUsdc } from "../src/usdc.js";

/** CAIP-2 identifiers for Arc. Gateway wants these, not raw chain ids. */
export const NETWORKS = {
  testnet: "eip155:5042002",
  mainnet: "eip155:5042",
};

export const FACILITATORS = {
  testnet: "https://gateway-api-testnet.circle.com",
  mainnet: "https://gateway-api.circle.com",
};

/** Price string in the form Gateway expects, e.g. "$0.0012". */
export function quoteFor(timeoutMs) {
  return `$${formatUsdc(costOf(clampTimeout(timeoutMs)), 6)}`;
}

/**
 * @param {object} opts
 * @param {string} opts.sellerAddress    Wallet that receives revenue.
 * @param {"testnet"|"mainnet"} [opts.network]
 * @param {string} [opts.facilitatorUrl] Override the Circle facilitator.
 * @param {string} [opts.backend]        Sandbox backend override.
 */
export async function createX402Service({
  sellerAddress,
  network = "testnet",
  facilitatorUrl,
  backend,
}) {
  if (!sellerAddress) throw new Error("sellerAddress is required");

  const chosenBackend = backend ?? (await selectBackend());
  const caip2 = NETWORKS[network];
  if (!caip2) throw new Error(`unknown network "${network}" (use testnet or mainnet)`);

  const resolvedFacilitator = facilitatorUrl ?? FACILITATORS[network];

  const gateway = createGatewayMiddleware({
    sellerAddress,
    networks: caip2,
    facilitatorUrl: resolvedFacilitator,
    description: "Sandboxed code execution, billed per run",
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  // ---- free -------------------------------------------------------------

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      backend: chosenBackend,
      isolated: chosenBackend === "docker",
      network: caip2,
      settlement: "circle-gateway-nanopayments",
    });
  });

  app.get("/pricing", (_req, res) => {
    res.json({
      ...rateCard(),
      languages: Object.keys(LANGUAGES),
      payment: {
        protocol: "x402",
        settlement: "Circle Gateway Nanopayments (batched, gasless for the payer)",
        network: caip2,
        payTo: sellerAddress,
        facilitator: resolvedFacilitator,
      },
      quoting: "You are quoted from the timeout you request. Request less, pay less.",
    });
  });

  // ---- metered ----------------------------------------------------------

  /**
   * Price this request from its own body, then hand off to Gateway.
   *
   * `gateway.require()` takes a fixed price, so a route whose cost varies has
   * to build its middleware per request rather than once at mount time.
   */
  const priced = (priceOf) => (req, res, next) => {
    let price;
    try {
      price = priceOf(req);
    } catch {
      price = quoteFor(PRICING.defaultTimeoutMs);
    }
    res.setHeader("x-sandbox-quote", price);
    return gateway.require(price)(req, res, next);
  };

  app.post(
    "/v1/run",
    priced((req) => quoteFor(req.body?.timeoutMs)),
    async (req, res) => {
      const { language, code, stdin } = req.body ?? {};
      const timeoutMs = clampTimeout(req.body?.timeoutMs);

      try {
        const result = await run({
          language,
          code,
          stdin: typeof stdin === "string" ? stdin : "",
          limits: { timeoutMs },
          backend: chosenBackend,
        });

        res.json({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
          isolated: result.isolated,
          billing: {
            quoted: quoteFor(timeoutMs),
            // What measured billing would have charged — so a caller can see
            // the headroom they paid for and lower their timeout next time.
            actualCost: `$${formatUsdc(costOf(result.durationMs), 6)}`,
            payer: req.payment?.payer ?? null,
            network: req.payment?.network ?? caip2,
            settlement: "batched by Circle Gateway",
          },
        });
      } catch (err) {
        if (err instanceof SandboxError) {
          return res.status(400).json({ error: "bad_request", message: err.message });
        }
        console.error("[x402-service] sandbox error:", err);
        res.status(500).json({ error: "sandbox_failure", message: "the sandbox could not run" });
      }
    },
  );

  return {
    app,
    gateway,
    backend: chosenBackend,
    network: caip2,
    sellerAddress,
    facilitator: resolvedFacilitator,
  };
}
