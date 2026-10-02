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
  parseAbi,
  formatUnits,
} from "viem";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "../scripts/artifact.js";
import { ArenaIndexer } from "../arena/indexer.js";
import { chainIndex, RESET_EVENTS } from "../arena/returns.js";
import { createRiskEngine, snapshot } from "../bridge/risk.js";
import { mountStrategy } from "./strategy/routes.js";
import { mountOnramp } from "./onramp.js";
import { buildActivity } from "./activity.js";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

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

export function createApp({ deployment, rpcUrl, strategy, onramp, publicClient } = {}) {
  const dep = deployment ?? loadDeployment();
  const chain = dep.chainId === arc.id ? arc : arcTestnet;
  const explorer = dep.chainId === arc.id ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io";

  const app = express();
  // Behind a reverse proxy every visitor arrives from the proxy's address, which
  // would put everyone in one rate-limit bucket. TRUST_PROXY names the hops to
  // trust (a count, or "loopback"); unset, the socket address is used as is.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  app.use(express.json({ limit: "64kb" }));

  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, "public")));

  // Chain access is created lazily so the encoding endpoints need no RPC.
  let client = null;
  let indexer = null;
  const getClient = () => {
    client ??= publicClient ?? createPublicClient({
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

  // The strategy chat: plain words to a validated spec and its backtest.
  mountStrategy(app, strategy);

  // Card funding: buy USDC into your own wallet with Circle's Onramp Kit.
  mountOnramp(app, onramp);

  // A wallet's USDC, so the page can show it and see a card purchase land.
  app.get("/api/usdc/:address", async (req, res) => {
    try {
      const { address } = req.params;
      if (!isAddress(address, { strict: false })) return res.status(400).json({ error: "not a wallet address" });
      const raw = await getClient().readContract({ address: dep.external.usdc, abi: ERC20, functionName: "balanceOf", args: [address] });
      res.set("cache-control", "no-store");
      res.json({ address, usdc: Number(formatUnits(raw, USDC_DECIMALS)) });
    } catch (err) {
      fail(res, err);
    }
  });

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

  // Each agent's whole history is cached; callers take the newest `limit`.
  // The activity totals need all of it, the pages need the latest 50.
  const historyCache = new Map();
  const HISTORY_SHOWN = 50;
  const getHistory = async (address, limit = HISTORY_SHOWN) => {
    const key = address.toLowerCase();
    const hit = historyCache.get(key);
    if (hit && Date.now() - hit.at < BOARD_TTL) return hit.data.slice(0, limit);
    try {
      const data = await getIndexer().history(address, { limit: Infinity });
      historyCache.set(key, { at: Date.now(), data });
      return data.slice(0, limit);
    } catch (err) {
      if (hit) return hit.data.slice(0, limit);
      throw err;
    }
  };

  // A block's timestamp never changes, so each is read once.
  const blockTimes = new Map();
  const timeOf = async (block) => {
    if (!blockTimes.has(block)) {
      try {
        const header = await getClient().getBlock({ blockNumber: BigInt(block) });
        blockTimes.set(block, Number(header.timestamp));
      } catch {
        return null; // try again next time
      }
    }
    return blockTimes.get(block);
  };

  // The home page's feed: the latest events across every agent, and totals.
  // Agents are read one at a time: each history is a paged eth_getLogs scan,
  // and the public RPC rate-limits bursts of them. A cold scan can take
  // minutes, so the route answers after ACTIVITY_BUDGET_MS with what is ready
  // ("partial": true) and the scan carries on for the page's next refresh.
  const ACTIVITY_AGENTS = 25;
  const ACTIVITY_BUDGET_MS = 8_000;
  let warming = null;
  const warmHistories = (list) => {
    warming ??= (async () => {
      for (const m of list) {
        try {
          await getHistory(m.address, Infinity);
        } catch {
          // left out until a later refresh reads it
        }
      }
    })().finally(() => { warming = null; });
    return warming;
  };
  app.get("/api/activity", async (_req, res) => {
    try {
      const board = await getBoard();
      const newest = [...board.mandates]
        .sort((a, b) => Number(b.createdAtBlock) - Number(a.createdAtBlock))
        .slice(0, ACTIVITY_AGENTS);
      let budget;
      await Promise.race([
        warmHistories(newest),
        new Promise((resolve) => { budget = setTimeout(resolve, ACTIVITY_BUDGET_MS); }),
      ]);
      clearTimeout(budget);
      const histories = new Map();
      for (const m of newest) {
        const hit = historyCache.get(m.address.toLowerCase());
        if (hit) histories.set(m.address.toLowerCase(), hit.data);
      }
      // A stale cache entry is still served; only a history never read makes this partial.
      const { events, totals, partial } = buildActivity({ mandates: newest, histories });
      const times = await Promise.all(events.map((e) => timeOf(e.block)));
      res.json({
        explorer,
        block: board.block ?? null,
        events: events.map((e, i) => ({ ...e, t: times[i] })),
        // agents and live cover every agent; trades and freezes cover the `scanned` newest.
        totals: { ...totals, agents: board.mandates.length, live: board.mandates.filter((m) => !m.closed).length },
        scanned: newest.length,
        partial,
      });
    } catch (err) {
      fail(res, err);
    }
  });

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

  // The bridge's risk engine, run on the vault's live state with its default settings:
  // the same answer the bridge would give before sending a trade.
  const risk = createRiskEngine();
  app.get("/api/mandate/:address/risk", async (req, res) => {
    try {
      if (!isAddress(req.params.address)) throw refuse("that is not an address");
      const board = await getBoard();
      const row = board.mandates.find((m) => m.address.toLowerCase() === req.params.address.toLowerCase());
      if (!row) {
        const err = new Error("no mandate from this factory at that address");
        err.status = 404;
        throw err;
      }
      res.json({ address: row.address, block: board.block ?? null, ...(await snapshot(risk, row)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // --------------------------------------------------------------- encoding
  app.post("/api/tx/create", (req, res) => {
    try {
      const { name, agent, rules } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length < 1 || name.length > NAME_MAX)
        throw refuse(`the agent needs a name of 1 to ${NAME_MAX} characters`);
      if (typeof agent !== "string" || !isAddress(agent))
        throw refuse("the trading key must be a valid address — the key that will trade, never withdraw");

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
      if (typeof mandate !== "string" || !isAddress(mandate)) throw refuse("that agent address is not valid");
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

  /**
   * Owner and public actions on an existing mandate. Only a fixed set of
   * calls can be encoded here; anything else is refused rather than guessed.
   * Whether the caller may make the call is the contract's job, not ours.
   */
  const ZERO = "0x0000000000000000000000000000000000000000";
  app.post("/api/tx/action", (req, res) => {
    try {
      const { mandate, action } = req.body ?? {};
      if (typeof mandate !== "string" || !isAddress(mandate)) throw refuse("that agent address is not valid");
      const call = (functionName, args = []) => encodeFunctionData({ abi: MANDATE.abi, functionName, args });

      let data;
      let label;
      if (action === "withdrawAll") {
        data = call("withdrawAll");
        label = "withdraw everything and remove the agent";
      } else if (action === "checkpoint") {
        data = call("checkpoint");
        label = "freeze — only succeeds below the floor";
      } else if (action === "unfreeze") {
        data = call("unfreeze");
        label = "unfreeze";
      } else if (action === "withdraw") {
        const { token, amount } = req.body;
        const known = [dep.external.usdc, dep.external.eurc].map((a) => a.toLowerCase());
        if (typeof token !== "string" || !known.includes(token.toLowerCase()))
          throw refuse("that token is not one this agent can hold");
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) throw refuse("the withdrawal must be a positive amount");
        data = call("withdraw", [getAddress(token), parseUnits(String(n), 6)]);
        label = `withdraw ${n}`;
      } else if (action === "setAgent") {
        const { agent } = req.body;
        if (typeof agent !== "string" || !isAddress(agent)) throw refuse("the new trading key must be a valid address");
        data = call("setAgent", [getAddress(agent)]);
        label = agent.toLowerCase() === ZERO ? "revoke the agent" : `set the agent to ${agent.slice(0, 8)}…`;
      } else {
        throw refuse("unknown action");
      }
      res.json({ to: mandate, data, label, chainId: dep.chainId });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * The equity chart, built only from the chain: equity() read at the end of
   * each block where the mandate did something, plus the live value now. Past
   * blocks never change, so each sample is cached for good.
   */
  const samples = new Map(); // "mandate:block" -> { t, equityUsd } | null
  app.get("/api/mandate/:address/series", async (req, res) => {
    try {
      if (!isAddress(req.params.address)) throw refuse("that is not an address");
      const board = await getBoard();
      const row = board.mandates.find((m) => m.address.toLowerCase() === req.params.address.toLowerCase());
      if (!row) {
        const err = new Error("no mandate from this factory at that address");
        err.status = 404;
        throw err;
      }
      const history = [...(await getHistory(row.address))].reverse(); // oldest first
      const blocks = [...new Set(history.map((e) => e.block))];
      const client = getClient();

      const sample = async (block) => {
        const key = `${row.address.toLowerCase()}:${block}`;
        if (!samples.has(key)) {
          try {
            // Baseline alongside equity: between money movements, equity /
            // baseline is the return. Across them, chainIndex takes over.
            const [raw, base, header] = await Promise.all([
              client.readContract({ address: row.address, abi: MANDATE.abi, functionName: "equity", blockNumber: BigInt(block) }),
              client.readContract({ address: row.address, abi: MANDATE.abi, functionName: "baseline", blockNumber: BigInt(block) }),
              client.getBlock({ blockNumber: BigInt(block) }),
            ]);
            samples.set(key, { t: Number(header.timestamp), equityUsd: Number(raw) / 1e6, baselineUsd: Number(base) / 1e6 });
          } catch {
            samples.set(key, null); // a stale feed, or before the mandate existed: no point
          }
        }
        return samples.get(key);
      };

      const points = [];
      for (const block of blocks) {
        const events = history.filter((e) => e.block === block).map((e) => e.event);
        const reset = events.some((e) => RESET_EVENTS.has(e));
        // A deposit, withdrawal or unfreeze moves the baseline. Read the block
        // just before it too, so the performance up to the movement counts and
        // the movement itself counts as nothing.
        if (reset) {
          const before = await sample(Number(block) - 1);
          if (before) points.push({ ...before, block: String(Number(block) - 1), events: [] });
        }
        const s = await sample(block);
        if (s) points.push({ ...s, block, events, reset });
      }
      if (row.equityUsd != null) {
        points.push({ t: Math.floor(Date.now() / 1000), equityUsd: row.equityUsd, baselineUsd: row.baselineUsd, block: null, events: ["now"] });
      }
      res.json({ points: chainIndex(points) });
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

// Started directly (`npm run app`), not imported (tests, the Vercel function in api/).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dep = loadDeployment();
  const app = createApp({ deployment: dep, rpcUrl: process.env.APP_RPC });
  const port = Number(process.env.PORT ?? 4100);
  app.listen(port, () => {
    console.log(`\n  Reins app on :${port}`);
    console.log(`  network  ${dep.network} (${dep.chainId})`);
    console.log(`  factory  ${dep.contracts.mandateFactory}\n`);
  });
}
