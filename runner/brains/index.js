/**
 * The hosted strategies. Each is a pure function from an agent's status and
 * its settings to a decision with a plain reason; nothing here touches the
 * network, so every branch is a unit test (test/runner-brains.test.js).
 *
 * Today an agent on Arc can hold USDC and EURC, so both strategies work on the
 * share of the agent held in EURC. A decision becomes a signal in the bridge's
 * shape, and the bridge's executor and risk engine take it from there.
 */
const HOUR_MS = 3_600_000;
export const MIN_TRADE_USD = 0.05; // smaller than this isn't worth the gas
const BASE = "USDC";
const ASSET = "EURC";

const pct = (x) => `${Math.round(x * 100)}%`;
const cents = (x) => Math.floor(x * 100) / 100;
const usd = (x) => `$${x.toFixed(2)}`;
const hold = (reason) => ({ side: "hold", reason });
const hoursAgo = (ms) => (ms < HOUR_MS ? "under an hour ago" : `${Math.floor(ms / HOUR_MS)}h ago`);

/** Where the agent stands, or why it can't be read safely. */
function position(status) {
  if (!status.canTrade) {
    return { blocked: status.frozen ? "Held: the agent is frozen" : "Held: the agent can't trade right now (expired, or a stale price)" };
  }
  const eurc = status.holdings.find((h) => h.symbol === ASSET);
  const cash = status.holdings.find((h) => h.symbol === BASE)?.amount ?? 0;
  if (status.equityUsd === null || !eurc || eurc.valueUsd === null) return { blocked: "Held: no fresh price, so it won't trade blind" };
  const equity = status.equityUsd;
  return { equity, cash, eurcUsd: eurc.valueUsd, share: equity > 0 ? eurc.valueUsd / equity : 0 };
}

export const STRATEGIES = {
  savings: {
    label: "Euro savings",
    params: {
      buyUsd: { default: 5, min: 0.1, max: 10_000 },
      everyHours: { default: 24, min: 1, max: 720 },
      targetShare: { default: 0.5, min: 0.05, max: 1 },
    },
    decide(status, s, ctx = {}) {
      const p = position(status);
      if (p.blocked) return hold(p.blocked);
      // Spaced from its last actual buy, not from the clock: no two buys minutes
      // apart across a boundary, and a failed attempt doesn't cost a period.
      if (ctx.lastTradeAt != null && ctx.now != null && ctx.now - ctx.lastTradeAt < s.everyHours * HOUR_MS) {
        const left = Math.ceil((s.everyHours * HOUR_MS - (ctx.now - ctx.lastTradeAt)) / HOUR_MS);
        return hold(`Held: it bought ${hoursAgo(ctx.now - ctx.lastTradeAt)}; next buy in about ${left}h`);
      }
      if (p.share >= s.targetShare - 1e-9) return hold(`Held: EURC is ${pct(p.share)} of the agent; it has reached its ${pct(s.targetShare)} target`);
      const size = cents(Math.min(s.buyUsd, s.targetShare * p.equity - p.eurcUsd, p.cash));
      if (size < MIN_TRADE_USD) return hold(p.cash < MIN_TRADE_USD ? "Held: no USDC left to buy with" : "Held: too close to its target to be worth a trade");
      return { side: "buy", sizeUsd: size, reason: `Buying ${usd(size)} of EURC: it's ${pct(p.share)} of the agent, aiming for ${pct(s.targetShare)}` };
    },
  },
  balance: {
    label: "50/50 balance",
    params: {
      target: { default: 0.5, min: 0.05, max: 0.95 },
      band: { default: 0.05, min: 0.01, max: 0.25 },
    },
    decide(status, s) {
      const p = position(status);
      if (p.blocked) return hold(p.blocked);
      const lo = s.target - s.band, hi = s.target + s.band;
      const range = `${Math.round(lo * 100)}–${pct(hi)}`;
      if (p.share >= lo - 1e-9 && p.share <= hi + 1e-9) return hold(`Held: EURC is ${pct(p.share)} of the agent, inside ${range}`);
      if (p.share < lo) {
        const size = cents(Math.min(s.target * p.equity - p.eurcUsd, p.cash));
        if (size < MIN_TRADE_USD) return hold("Held: the gap is too small to be worth a trade");
        return { side: "buy", sizeUsd: size, reason: `Buying ${usd(size)} of EURC: it had fallen to ${pct(p.share)}, below ${range}` };
      }
      const sellUsd = p.eurcUsd - s.target * p.equity;
      if (sellUsd < MIN_TRADE_USD) return hold("Held: the gap is too small to be worth a trade");
      return { side: "sell", fraction: sellUsd / p.eurcUsd, reason: `Selling ${usd(sellUsd)} of EURC: it had grown to ${pct(p.share)}, above ${range}` };
    },
  },
};

const strategyOf = (name) => {
  const s = STRATEGIES[name];
  if (!s) throw new Error(`unknown strategy "${String(name).slice(0, 40)}"; choose ${Object.keys(STRATEGIES).join(" or ")}`);
  return s;
};

/** A strategy's settings: defaults filled in, bounds checked, anything unknown dropped. */
export function settingsFor(name, input = {}) {
  const { params } = strategyOf(name);
  const out = {};
  for (const [k, p] of Object.entries(params)) {
    const v = input[k] === undefined ? p.default : Number(input[k]);
    if (!Number.isFinite(v) || v < p.min || v > p.max) throw new Error(`${k} must be between ${p.min} and ${p.max}`);
    out[k] = v;
  }
  return out;
}

/** @param {{ now?: number, lastTradeAt?: number|null }} [ctx]  what the strategy may need beyond the agent's status */
export const decide = (name, status, settings, ctx = {}) => strategyOf(name).decide(status, settings, ctx);

/**
 * A decision as the executor's signal. Its id is once-only per pass: run the
 * same pass twice and the second is a duplicate. How often a strategy trades
 * is the strategy's own business (savings spaces its buys from its last trade).
 */
export function signalFor({ strategy, mandate, now, tickMs, decision }) {
  strategyOf(strategy);
  const id = `${mandate.toLowerCase()}:${strategy}:${decision.side === "hold" ? "hold" : "act"}:${Math.floor(now / tickMs)}`;
  return {
    source: `reins:${strategy}`,
    id,
    side: decision.side,
    asset: ASSET,
    quote: "USD",
    sizeUsd: decision.sizeUsd,
    fraction: decision.fraction,
    reason: decision.reason,
  };
}
