/**
 * A paid API. The only Ratchet-specific line is `app.use(meter(...))`.
 *
 * Everything below it is an ordinary Express route that has no idea it is being
 * billed per call — which is the point.
 */
import express from "express";
import { meter, MemoryLedger } from "../src/server.js";

export function createApi({ vault, provider, chain, publicClient, wallet, price, settleAt }) {
  const app = express();
  const ledger = new MemoryLedger();

  app.use(express.json());

  // Free endpoint: pricing and liveness, no payment required.
  app.get("/pricing", (_req, res) => {
    res.json({ price, currency: "USDC", chain: chain.name, vault, provider });
  });

  // Everything under /v1 is metered.
  app.use(
    "/v1",
    meter({ price, provider, vault, chain, publicClient, wallet, settleAt, ledger }),
  );

  app.post("/v1/sentiment", (req, res) => {
    const text = String(req.body?.text ?? "");
    const positive = (text.match(/\b(good|great|love|excellent|up|win|strong)\b/gi) ?? []).length;
    const negative = (text.match(/\b(bad|terrible|hate|awful|down|loss|weak)\b/gi) ?? []).length;
    const score = positive + negative === 0 ? 0 : (positive - negative) / (positive + negative);

    res.json({
      score,
      label: score > 0.2 ? "positive" : score < -0.2 ? "negative" : "neutral",
      tokens: text.split(/\s+/).filter(Boolean).length,
      // Handy for the caller: what this call cost and what is left.
      billing: {
        charged: req.ratchet.charged.toString(),
        remaining: req.ratchet.remaining.toString(),
        callsThisChannel: req.ratchet.calls,
      },
    });
  });

  return { app, ledger };
}
