/**
 * The arena: a public leaderboard of AI agents trading under mandates.
 *
 *   node --env-file=.env arena/server.js
 *
 * Everything it shows is read from the chain at request time, so anyone can
 * check it against a public RPC. There is no database and no admin.
 *
 * Environment:
 *   ARENA_FACTORY      MandateFactory address (default: deployments/<net>.json)
 *   ARENA_NETWORK      mainnet | testnet | local        (default mainnet)
 *   ARENA_FROM_BLOCK   block the factory was deployed   (default 0)
 *   ARENA_RPC          RPC override
 *   PORT                                                (default 4090)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createPublicClient, http, defineChain } from "viem";
import { arc, arcTestnet } from "viem/chains";

import { ArenaIndexer } from "./indexer.js";

const here = dirname(fileURLToPath(import.meta.url));
const network = process.env.ARENA_NETWORK ?? "mainnet";
const port = Number(process.env.PORT ?? 4090);

const localChain = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});
const chain = network === "testnet" ? arcTestnet : network === "local" ? localChain : arc;

function factoryAddress() {
  if (process.env.ARENA_FACTORY) return process.env.ARENA_FACTORY;
  const file = `deployments/${network}.json`;
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (d.contracts?.mandateFactory) return d.contracts.mandateFactory;
  }
  return null;
}

const factory = factoryAddress();
if (!factory) {
  console.error(`\n  No factory address. Set ARENA_FACTORY, or deploy first (npm run deploy:mandate).\n`);
  process.exit(1);
}

const publicClient = createPublicClient({ chain, transport: http(process.env.ARENA_RPC) });
const indexer = new ArenaIndexer({
  publicClient,
  factory,
  fromBlock: BigInt(process.env.ARENA_FROM_BLOCK ?? 0),
});

/** Cache the leaderboard briefly: the page polls, and the RPC is shared. */
let cached = { at: 0, value: null };
async function leaderboard() {
  if (Date.now() - cached.at < 5_000 && cached.value) return cached.value;
  const value = await indexer.leaderboard();
  cached = { at: Date.now(), value };
  return value;
}

const app = express();
app.disable("x-powered-by");

app.get("/api/leaderboard", async (_req, res, next) => {
  try {
    res.json({ network, chainId: chain.id, factory, ...(await leaderboard()) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/mandate/:address", async (req, res, next) => {
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) {
      return res.status(400).json({ error: "bad_request", message: "not an address" });
    }
    const board = await leaderboard();
    const row = board.mandates.find((m) => m.address.toLowerCase() === req.params.address.toLowerCase());
    if (!row) return res.status(404).json({ error: "not_found", message: "no mandate from this factory at that address" });
    res.json({ ...row, history: await indexer.history(row.address) });
  } catch (err) {
    next(err);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, network, factory }));
app.use(express.static(join(here, "public")));

app.use((err, _req, res, _next) => {
  console.error("[arena]", err);
  res.status(500).json({ error: "internal", message: "could not read the chain right now" });
});

app.listen(port, () => {
  console.log(`\n  Arena on :${port}`);
  console.log(`  network  ${chain.name} (${chain.id})`);
  console.log(`  factory  ${factory}\n`);
});
