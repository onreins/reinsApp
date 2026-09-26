/**
 * The arena's reader: every mandate, its rules, its money and its trades,
 * built from chain data alone.
 *
 * No database and nothing to trust. Mandates announce themselves through the
 * factory's `MandateCreated` event; each one's trades, freezes, deposits and
 * withdrawals are its own events. Anyone can rebuild this page's contents from
 * a public RPC, which is the point.
 *
 * Arc's public RPC refuses `eth_getLogs` over 9,999 blocks and rejects
 * multi-event topic filters, so reads are paged and filtered locally — the same
 * lesson the evaluator learned the hard way.
 */
import { formatUnits, parseAbi, decodeEventLog } from "viem";

import { artifact } from "../scripts/artifact.js";

const MANDATE = artifact("Mandate");
const FACTORY = artifact("MandateFactory");
const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const FEED = [
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

export const LOG_WINDOW = 9_999n;

/** Split [from, to] into windows the public RPC will accept. */
export function windows(from, to, size = LOG_WINDOW) {
  const out = [];
  for (let start = from; start <= to; start += size + 1n) {
    const end = start + size > to ? to : start + size;
    out.push([start, end]);
  }
  return out;
}

export class ArenaIndexer {
  /**
   * @param {object} p
   * @param {import("viem").PublicClient} p.publicClient
   * @param {`0x${string}`} p.factory
   * @param {bigint} [p.fromBlock]  where the factory was deployed
   */
  constructor({ publicClient, factory, fromBlock = 0n }) {
    this.publicClient = publicClient;
    this.factory = factory;
    this.fromBlock = fromBlock;
    this.meta = new Map(); // mandate address → tokens it can hold
    this.logCache = new Map(); // address → { from, to, logs } already read
    this.logLocks = new Map(); // address → the scan currently running for it
  }

  /**
   * Logs for one address, read incrementally. Each address keeps what it has
   * already read and the last block covered, so a refresh only asks for new
   * blocks. Progress is saved per window: a scan cut off by a rate limit
   * resumes at the window that failed instead of starting over.
   */
  _logs({ address, fromBlock, toBlock }) {
    // One scan per address at a time: two readers racing would fetch the
    // same windows and append them twice.
    const key = address.toLowerCase();
    const run = (this.logLocks.get(key) ?? Promise.resolve()).then(() =>
      this._scan({ address, key, fromBlock, toBlock }),
    );
    this.logLocks.set(key, run.catch(() => {}));
    return run;
  }

  async _scan({ address, key, fromBlock, toBlock }) {
    let entry = this.logCache.get(key);
    if (!entry || entry.from !== fromBlock) {
      entry = { from: fromBlock, to: fromBlock - 1n, logs: [] };
      this.logCache.set(key, entry);
    }
    if (toBlock > entry.to) {
      for (const [from, to] of windows(entry.to + 1n, toBlock)) {
        const batch = await this.publicClient.getLogs({ address, fromBlock: from, toBlock: to });
        entry.logs.push(...batch);
        entry.to = to;
      }
    }
    return toBlock >= entry.to ? entry.logs.slice() : entry.logs.filter((l) => l.blockNumber <= toBlock);
  }

  /** Every mandate the factory has ever created. */
  async mandates({ toBlock } = {}) {
    const head = toBlock ?? (await this.publicClient.getBlockNumber({ cacheTime: 0 }));
    const logs = await this._logs({ address: this.factory, fromBlock: this.fromBlock, toBlock: head });
    return logs
      .map((log) => {
        try {
          const e = decodeEventLog({ abi: FACTORY.abi, ...log });
          if (e.eventName !== "MandateCreated") return null;
          return {
            address: e.args.mandate,
            owner: e.args.owner,
            agent: e.args.agent,
            name: e.args.name,
            createdAtBlock: log.blockNumber.toString(),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Token details for one mandate, cached: base first, then its assets. */
  async _tokens(mandate) {
    if (this.meta.has(mandate)) return this.meta.get(mandate);
    const read = (functionName, args = []) =>
      this.publicClient.readContract({ address: mandate, abi: MANDATE.abi, functionName, args });
    const [base, assets] = await Promise.all([read("base"), read("assetList")]);
    const tokens = {};
    for (const [i, address] of [base, ...assets].entries()) {
      const [symbol, decimals] = await Promise.all([
        this.publicClient.readContract({ address, abi: ERC20, functionName: "symbol" }),
        this.publicClient.readContract({ address, abi: ERC20, functionName: "decimals" }),
      ]);
      // Each non-base asset is priced by the feed the mandate was created with.
      const feed = i === 0 ? null : (await read("assets", [address]))[0];
      tokens[address.toLowerCase()] = { address, symbol, decimals, isBase: i === 0, feed };
    }
    this.meta.set(mandate, tokens);
    return tokens;
  }

  /** Dollar value of a holding: the base at face, the rest at their own feed. */
  async _value(token, amount) {
    if (token.isBase) return amount;
    if (!token.feed) return null;
    try {
      const [[, answer], decimals] = await Promise.all([
        this.publicClient.readContract({ address: token.feed, abi: FEED, functionName: "latestRoundData" }),
        this.publicClient.readContract({ address: token.feed, abi: FEED, functionName: "decimals" }),
      ]);
      return amount * (Number(answer) / 10 ** Number(decimals));
    } catch {
      return null; // a broken feed: the amount is still true, the value unknown
    }
  }

  /** One mandate's standing: money, rules, and how it's doing. */
  async snapshot(entry) {
    const mandate = entry.address;
    const read = (functionName, args = []) =>
      this.publicClient.readContract({ address: mandate, abi: MANDATE.abi, functionName, args });
    const tokens = await this._tokens(mandate);
    const base = Object.values(tokens).find((t) => t.isBase);

    const fields = ["agent", "frozen", "expiresAt", "maxTradeValue", "maxDrawdownBps", "maxSlippageBps", "baseline", "floor"];
    const [agent, frozen, expiresAt, maxTradeValue, maxDrawdownBps, maxSlippageBps, baseline, floor] = await Promise.all(
      fields.map((f) => read(f)),
    );

    let equity = null;
    try {
      equity = await read("equity");
    } catch {
      // A stale feed: equity can't be valued, and the contract blocks trading until it updates.
    }

    const holdings = await Promise.all(
      Object.values(tokens).map(async (t) => {
        const raw = await this.publicClient.readContract({
          address: t.address,
          abi: ERC20,
          functionName: "balanceOf",
          args: [mandate],
        });
        const amount = Number(formatUnits(raw, t.decimals));
        return { symbol: t.symbol, amount, valueUsd: await this._value(t, amount) };
      }),
    );

    const usd = (v) => Number(formatUnits(v, base.decimals));
    const equityUsd = equity === null ? null : usd(equity);
    const baselineUsd = usd(baseline);
    return {
      ...entry,
      agent,
      frozen,
      expired: Date.now() / 1000 >= Number(expiresAt),
      expiresAt: new Date(Number(expiresAt) * 1000).toISOString(),
      equityUsd,
      baselineUsd,
      floorUsd: usd(floor),
      // The owner took everything back. It is finished, not an agent sitting
      // on an empty balance, and the arena should not rank it as one.
      closed: baselineUsd === 0 && equityUsd === 0,
      // Return since the mandate was funded: the arena's ranking.
      returnPct: equityUsd === null || baselineUsd === 0 ? null : ((equityUsd - baselineUsd) / baselineUsd) * 100,
      holdings,
      rules: {
        maxTradeUsd: usd(maxTradeValue),
        maxLossPercent: Number(maxDrawdownBps) / 100,
        maxSlippagePercent: Number(maxSlippageBps) / 100,
        allowedAssets: Object.values(tokens).map((t) => t.symbol),
      },
    };
  }

  /** What a mandate has actually done, newest first. */
  async history(mandate, { limit = 50, toBlock } = {}) {
    const head = toBlock ?? (await this.publicClient.getBlockNumber({ cacheTime: 0 }));
    const tokens = await this._tokens(mandate);
    const base = Object.values(tokens).find((t) => t.isBase);
    const logs = await this._logs({ address: mandate, fromBlock: this.fromBlock, toBlock: head });
    const sym = (address) => tokens[String(address).toLowerCase()];
    const events = [];

    for (const log of logs) {
      let e;
      try {
        e = decodeEventLog({ abi: MANDATE.abi, ...log });
      } catch {
        continue;
      }
      const at = { block: log.blockNumber.toString(), tx: log.transactionHash, event: e.eventName };
      if (e.eventName === "Traded") {
        const tIn = sym(e.args.tokenIn);
        const tOut = sym(e.args.tokenOut);
        events.push({
          ...at,
          sold: { symbol: tIn?.symbol ?? e.args.tokenIn, amount: Number(formatUnits(e.args.amountIn, tIn?.decimals ?? 18)) },
          bought: { symbol: tOut?.symbol ?? e.args.tokenOut, amount: Number(formatUnits(e.args.amountOut, tOut?.decimals ?? 18)) },
          equityUsd: Number(formatUnits(e.args.equity, base.decimals)),
        });
      } else if (e.eventName === "Frozen") {
        events.push({
          ...at,
          equityUsd: Number(formatUnits(e.args.equity, base.decimals)),
          floorUsd: Number(formatUnits(e.args.floor, base.decimals)),
        });
      } else if (e.eventName === "Deposited" || e.eventName === "Withdrawn") {
        const t = e.eventName === "Withdrawn" ? sym(e.args.token) : base;
        events.push({
          ...at,
          amount: Number(formatUnits(e.args.amount, t?.decimals ?? base.decimals)),
          symbol: t?.symbol ?? base.symbol,
        });
      } else if (e.eventName === "AgentChanged") {
        events.push({ ...at, agent: e.args.agent });
      }
    }
    return events.reverse().slice(0, limit);
  }

  /** The whole arena: every mandate, ranked by return. */
  async leaderboard() {
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const entries = await this.mandates({ toBlock: head });
    const rows = await Promise.all(entries.map((e) => this.snapshot(e)));
    rows.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
    return { block: head.toString(), at: new Date().toISOString(), mandates: rows };
  }
}
