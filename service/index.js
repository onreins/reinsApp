/**
 * The service: a code sandbox that bills per millisecond, in USDC, with no
 * account, no API key and no subscription.
 *
 * An agent with a wallet can use it. Nothing else is required of it — no
 * signup, no card, no human.
 */
import express from "express";
import { meter, MemoryLedger } from "../src/server.js";
import { run, selectBackend, SandboxError, LANGUAGES } from "../src/sandbox.js";
import { formatUsdc } from "../src/usdc.js";
import { PRICING, costOf, ceilingFor, clampTimeout, rateCard } from "./pricing.js";

export async function createService({
  vault,
  provider,
  chain,
  publicClient,
  wallet,
  settleAt = "0.25",
  ledger = new MemoryLedger(),
  backend,
}) {
  const app = express();
  const chosenBackend = backend ?? (await selectBackend());

  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  // ---- free endpoints -----------------------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ ok: true, backend: chosenBackend, isolated: chosenBackend === "docker" });
  });

  app.get("/pricing", (_req, res) => {
    res.json({
      ...rateCard(),
      languages: Object.keys(LANGUAGES),
      payment: { protocol: "ratchet/1", chain: chain.name, chainId: chain.id, vault, provider },
    });
  });

  // ---- metered ------------------------------------------------------------

  app.use(
    "/v1",
    meter({
      // The ceiling is derived per request from the timeout the caller asked
      // for, so a caller requesting 1s is not asked to authorise 30s of budget.
      price: ceilingFor(PRICING.defaultTimeoutMs),
      priceFor: (req) => ceilingFor(clampTimeout(req.body?.timeoutMs)),
      provider,
      vault,
      chain,
      publicClient,
      wallet,
      settleAt,
      ledger,
    }),
  );

  app.post("/v1/run", async (req, res) => {
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

      const cost = costOf(result.durationMs);
      req.ratchet.charge(cost);

      res.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        isolated: result.isolated,
        billing: {
          charged: formatUsdc(cost),
          chargedRaw: cost.toString(),
          quoted: formatUsdc(req.ratchet.ceiling),
          breakdown: `${formatUsdc(PRICING.base)} base + ${result.durationMs}ms`,
        },
      });
    } catch (err) {
      if (err instanceof SandboxError) {
        // A malformed request is our fault to detect, not the caller's to fund.
        req.ratchet.charge(0n);
        return res.status(400).json({ error: "bad_request", message: err.message });
      }
      req.ratchet.charge(PRICING.base);
      res.status(500).json({ error: "sandbox_failure", message: "the sandbox could not run" });
      console.error("[service] sandbox error:", err);
    }
  });

  return { app, ledger, backend: chosenBackend };
}
