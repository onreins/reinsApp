/**
 * The Reins app server.
 *
 *   npm run app            # serves the app against Arc testnet
 *
 * Three jobs, deliberately small:
 *
 *   1. Tell the front-end which chain and contracts it is talking to.
 *   2. Read chain state through the same indexer the arena uses.
 *   3. Encode transactions. The browser never assembles ABI by hand and this
 *      server never holds a key: it returns calldata, the user's wallet signs.
 *
 * Validation here mirrors the contract's own bounds so a user is refused with
 * a sentence instead of a revert.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseUnits,
  parseEventLogs,
  isAddress,
  getAddress,
} from "viem";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "../scripts/artifact.js";
import { ArenaIndexer } from "../arena/indexer.js";

const FACTORY = artifact("MandateFactory");
const MANDATE = artifact("Mandate");
const ERC20_APPROVE = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

const USDC_DECIMALS = 6;
const NAME_MAX = 64;

/** Where this network's Mandate deployment was recorded. */
export function loadDeployment(network = process.env.APP_NETWORK ?? "testnet") {
  for (const file of [`deployments/mandate-${network}.json`, `deployments/${network}.json`]) {
    if (!existsSync(file)) continue;
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (d.contracts?.mandateFactory) return d;
  }
  throw new Error(`no Mandate deployment found for "${network}" — run the deploy script first`);
}

const refuse = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

/** Compile human-readable rules to the contract's units, or say what's wrong. */
export function compileRules(rules) {
  if (!rules || typeof rules !== "object") throw refuse("rules are missing");

  const maxTradeUsd = Number(rules.maxTradeUsd);
  if (!Number.isFinite(maxTradeUsd) || maxTradeUsd <= 0)
    throw refuse("the per-trade cap must be a positive dollar amount");

  const maxDrawdownBps = Math.round(Number(rules.maxLossPercent) * 100);
  if (!Number.isFinite(maxDrawdownBps) || maxDrawdownBps < 1 || maxDrawdownBps > 10_000)
    throw refuse("the loss limit must be between 0.01% and 100%");

  const maxSlippageBps = Math.round(Number(rules.maxSlippagePercent) * 100);
  if (!Number.isFinite(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 1_000)
    throw refuse("the slippage band must be between 0% and 10% — the contract refuses anything looser");

  const maxPriceAge = Math.round(Number(rules.maxPriceAgeSeconds));
  if (!Number.isFinite(maxPriceAge) || maxPriceAge < 60)
    throw refuse("the price-age limit must be at least 60 seconds");

  const expiryDays = Number(rules.expiryDays);
  if (!Number.isFinite(expiryDays) || expiryDays < 1 || expiryDays > 3_650)
    throw refuse("the expiry must be between 1 day and 10 years");

  return {
    maxTradeValue: parseUnits(String(maxTradeUsd), USDC_DECIMALS),
    maxDrawdownBps,
    maxSlippageBps,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + Math.round(expiryDays * 86_400)),
    maxPriceAge,
  };
}

export function createApp({ deployment, rpcUrl } = {}) {
  const dep = deployment ?? loadDeployment();
  const chain = dep.chainId === arc.id ? arc : arcTestnet;
  const explorer = dep.chainId === arc.id ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io";

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, "public")));

  // Chain access is created lazily so the encoding endpoints need no RPC.
  let client = null;
  let indexer = null;
  const getClient = () => {
    client ??= createPublicClient({
      chain,
      transport: http(rpcUrl, { batch: { wait: 16 }, retryCount: 5, retryDelay: 600 }),
      batch: { multicall: { wait: 16 } },
    });
    return client;
  };
  const getIndexer = () => {
    indexer ??= new ArenaIndexer({
      publicClient: getClient(),
      factory: dep.contracts.mandateFactory,
      fromBlock: BigInt(dep.fromBlock ?? 0),
    });
    return indexer;
  };

  const fail = (res, err) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error("[app]", err);
    res.status(status).json({ error: err.status ? err.message : "something went wrong on our side" });
  };

  // ------------------------------------------------------------------ reads
  app.get("/api/config", (_req, res) => {
    res.json({
      network: dep.network,
      chainId: dep.chainId,
      explorer,
      contracts: dep.contracts,
      tokens: {
        USDC: { address: dep.external.usdc, decimals: USDC_DECIMALS },
        EURC: { address: dep.external.eurc, decimals: 6, feed: dep.contracts.pinnedFeed },
      },
    });
  });

  // A public RPC rate-limits aggressive re-scans, so reads are cached for a
  // while and, when a refresh fails, the last good answer is served instead.
  // That stays honest: every payload carries the block it was read at.
  const BOARD_TTL = 30_000;
  let boardCache = { at: 0, data: null };
  let boardInFlight = null;
  const getBoard = async () => {
    if (boardCache.data && Date.now() - boardCache.at < BOARD_TTL) return boardCache.data;
    boardInFlight ??= getIndexer()
      .leaderboard()
      .then((data) => {
        boardCache = { at: Date.now(), data };
        return data;
      })
      .catch((err) => {
        if (boardCache.data) return boardCache.data; // stale beats a 500
        throw err;
      })
      .finally(() => { boardInFlight = null; });
    return boardInFlight;
  };

  const historyCache = new Map();
  const getHistory = async (address) => {
    const key = address.toLowerCase();
    const hit = historyCache.get(key);
    if (hit && Date.now() - hit.at < BOARD_TTL) return hit.data;
    try {
      const data = await getIndexer().history(address);
      historyCache.set(key, { at: Date.now(), data });
      return data;
    } catch (err) {
      if (hit) return hit.data;
      throw err;
    }
  };

  app.get("/api/leaderboard", async (_req, res) => {
    try {
      const data = await getBoard();
      res.json({ network: dep.network, chainId: dep.chainId, factory: dep.contracts.mandateFactory, ...data });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/mandate/:address", async (req, res) => {
    try {
      if (!isAddress(req.params.address)) throw refuse("that is not an address");
      const board = await getBoard();
      const row = board.mandates.find((m) => m.address.toLowerCase() === req.params.address.toLowerCase());
      if (!row) {
        const err = new Error("no mandate from this factory at that address");
        err.status = 404;
        throw err;
      }
      res.json({ ...row, history: await getHistory(row.address) });
    } catch (err) {
      fail(res, err);
    }
  });

  // --------------------------------------------------------------- encoding
  app.post("/api/tx/create", (req, res) => {
    try {
      const { name, agent, rules } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length < 1 || name.length > NAME_MAX)
        throw refuse(`the mandate needs a name of 1 to ${NAME_MAX} characters`);
      if (typeof agent !== "string" || !isAddress(agent))
        throw refuse("the agent must be a valid address — the key that will trade, never withdraw");

      const compiled = compileRules(rules);
      const data = encodeFunctionData({
        abi: FACTORY.abi,
        functionName: "create",
        args: [
          name.trim(),
          getAddress(agent),
          getAddress(dep.external.usdc),
          getAddress(dep.contracts.uniswapV4Venue),
          compiled,
          [getAddress(dep.external.eurc)],
          [getAddress(dep.contracts.pinnedFeed)],
        ],
      });
      res.json({ to: dep.contracts.mandateFactory, data, chainId: dep.chainId });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/tx/deposit", (req, res) => {
    try {
      const { mandate, amountUsd } = req.body ?? {};
      if (typeof mandate !== "string" || !isAddress(mandate)) throw refuse("that mandate address is not valid");
      const amount = Number(amountUsd);
      if (!Number.isFinite(amount) || amount <= 0) throw refuse("the deposit must be a positive dollar amount");

      const units = parseUnits(String(amount), USDC_DECIMALS);
      res.json({
        txs: [
          {
            to: dep.external.usdc,
            data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [getAddress(mandate), units] }),
            label: `approve $${amount} USDC`,
          },
          {
            to: mandate,
            data: encodeFunctionData({ abi: MANDATE.abi, functionName: "deposit", args: [units] }),
            label: `deposit $${amount}`,
          },
        ],
        chainId: dep.chainId,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** After the create lands: which mandate did it make? */
  app.get("/api/tx/created", async (req, res) => {
    try {
      const hash = req.query.hash;
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw refuse("pass the create transaction's hash");

      const receipt = await getClient().getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) return res.json({ status: "pending" });
      if (receipt.status !== "success") return res.json({ status: "reverted" });

      const events = parseEventLogs({ abi: FACTORY.abi, logs: receipt.logs, eventName: "MandateCreated" });
      if (!events.length) return res.json({ status: "reverted" });
      res.json({ status: "success", mandate: events[0].args.mandate });
    } catch (err) {
      fail(res, err);
    }
  });

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dep = loadDeployment();
  const app = createApp({ deployment: dep, rpcUrl: process.env.APP_RPC });
  const port = Number(process.env.PORT ?? 4100);
  app.listen(port, () => {
    console.log(`\n  Reins app on :${port}`);
    console.log(`  network  ${dep.network} (${dep.chainId})`);
    console.log(`  factory  ${dep.contracts.mandateFactory}\n`);
  });
}
