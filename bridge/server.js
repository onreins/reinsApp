/**
 * The Reins bridge: strategy brains in, mandate trades out.
 *
 *   POST /signal/freqtrade   a freqtrade webhook (NostalgiaForInfinity or any
 *                            freqtrade strategy, run unmodified in dry-run)
 *   POST /signal             a plain decision { source, ticker, decision, sizeUsd? }
 *                            (the TradingAgents runner posts here)
 *   GET  /ledger             recent outcomes
 *
 * Every request needs the shared secret, as `x-bridge-secret` or `?key=`
 * (freqtrade can only put it in the URL). The server binds to 127.0.0.1.
 *
 * It starts in shadow mode: signals are recorded, nothing is sent. Set
 * BRIDGE_MODE=live to trade. Either way, the mandate enforces every rule.
 *
 *   BRIDGE_SECRET=... MANDATE_ADDRESS=0x... MANDATE_AGENT_KEY=0x... \
 *     MANDATE_NETWORK=testnet npm run bridge
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { MandateClient } from "../mandate/sdk.js";
import { createRegistry } from "./registry.js";
import { fromFreqtrade, fromDecision } from "./signals.js";
import { createExecutor } from "./executor.js";
import { fileLedger } from "./ledger.js";

const here = dirname(fileURLToPath(import.meta.url));

function secretMatches(given, secret) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The HTTP surface, around an executor. Tests build it with a fake mandate. */
export function createBridgeApp({ executor, secret, ledger }) {
  if (typeof secret !== "string" || secret.length < 12) throw new Error("the bridge needs a shared secret of at least 12 characters");
  const app = express();
  // The secret is checked first, from the header or URL only, so an
  // unauthenticated caller never gets a request body parsed.
  app.use((req, res, next) => {
    if (secretMatches(req.get("x-bridge-secret") ?? req.query.key, secret)) return next();
    res.status(401).json({ error: "missing or wrong bridge secret" });
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  const handle = (parse) => async (req, res) => {
    let signal;
    try {
      signal = parse(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!signal) return res.json({ outcome: "ignored" });
    try {
      res.json(await executor.handle(signal));
    } catch (err) {
      console.error("bridge: signal failed:", err.message);
      res.status(502).json({ error: "the trade could not be sent; see the bridge log" });
    }
  };

  app.post("/signal/freqtrade", handle(fromFreqtrade));
  app.post("/signal", handle(fromDecision));
  app.get("/ledger", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json(ledger ? ledger.all().slice(-limit).reverse() : []);
  });

  // Anything that escapes a route (a malformed or oversized body, a bug) gets
  // a plain answer; details go to the bridge's own log, never to the caller.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("bridge: unhandled error:", err.message);
    res.status(status).json({ error: status === 500 ? "the bridge hit an internal error" : "that request body couldn't be read" });
  });
  return app;
}

async function main() {
  const address = process.env.MANDATE_ADDRESS;
  const key = process.env.MANDATE_AGENT_KEY;
  const secret = process.env.BRIDGE_SECRET;
  const mode = process.env.BRIDGE_MODE ?? "shadow";
  if (!isAddress(address ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) {
    throw new Error("set MANDATE_ADDRESS and MANDATE_AGENT_KEY (the agent's key, never the owner's)");
  }
  if (!secret) throw new Error("set BRIDGE_SECRET (any long random string; senders must present it)");

  const chain = process.env.MANDATE_NETWORK === "testnet" ? arcTestnet : arc;
  const transport = http(process.env.MANDATE_RPC);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport });
  const client = new MandateClient({ publicClient, wallet, address });

  const registry = createRegistry(JSON.parse(readFileSync(process.env.BRIDGE_ASSETS ?? join(here, "assets.json"), "utf8")));
  const ledger = fileLedger(process.env.BRIDGE_LEDGER ?? join(here, "data", "ledger.jsonl"));
  const executor = createExecutor({ client, registry, ledger, mode });
  const app = createBridgeApp({ executor, secret, ledger });

  const port = Number(process.env.BRIDGE_PORT ?? 4300);
  app.listen(port, "127.0.0.1", () => {
    console.log(`bridge: ${mode} mode, mandate ${address} on ${chain.name}, listening on 127.0.0.1:${port}`);
  });
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error("bridge failed:", err.message);
    process.exit(1);
  });
}
