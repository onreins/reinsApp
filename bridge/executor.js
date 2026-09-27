/**
 * Turn one signal into at most one trade inside a mandate.
 *
 * The executor is deliberately dull. It never widens a rule: it reads the
 * mandate's own limits, sizes the trade inside them, and lets the contract
 * have the last word. Every signal ends in exactly one ledger record:
 *
 *   traded     the trade went through (clamped: true if it was cut to the cap)
 *   refused    the contract said no; `rule` names which one
 *   unknown    sent, but not confirmed; `hash` says where to check. Never resent.
 *   skipped    nothing to do: frozen, no cash, nothing to sell
 *   shadow     the asset isn't in this mandate yet, or mode is "shadow"
 *   hold/none  the brain said hold, or asked for something impossible
 *   duplicate  this signal id was already handled
 */

const DECIMALS = 6; // USDC and EURC; a longer-decimal token just trades 6 places.

/** Round down to `dp` places and print without exponent or trailing zeros. */
function floorAmount(x, dp = DECIMALS) {
  const f = Math.floor(x * 10 ** dp + 1e-9) / 10 ** dp;
  return f.toFixed(dp).replace(/\.?0+$/, "");
}

/**
 * @param {object} p
 * @param {{ status(): Promise<any>, trade(t: any): Promise<any> }} p.client  a MandateClient (agent wallet)
 * @param {ReturnType<import("./registry.js").createRegistry>} p.registry
 * @param {{ append(r: any): void, has(id: string): boolean }} p.ledger
 * @param {"live"|"shadow"} [p.mode]  shadow: record intended trades, send none
 * @param {() => Date} [p.now]
 */
export function createExecutor({ client, registry, ledger, mode = "shadow", now = () => new Date() }) {
  if (mode !== "live" && mode !== "shadow") throw new Error(`mode must be "live" or "shadow", not ${mode}`);
  const inFlight = new Set();

  const record = (signal, fields) => {
    const r = { at: now().toISOString(), mode, signal, ...fields };
    ledger.append(r);
    return r;
  };

  async function plan(signal) {
    if (signal.side === "hold") return { outcome: "hold", reason: signal.reason };
    if (signal.side === "none") return { outcome: "none", reason: signal.reason };
    if (!registry.isQuote(signal.quote)) {
      return { outcome: "shadow", reason: `${signal.asset}/${signal.quote}: only pairs against dollars can map to a mandate` };
    }

    const symbol = registry.symbolFor(signal.asset);
    const status = await client.status();
    const allowed = status.rules.allowedAssets;
    const base = allowed[0];
    if (!symbol || !allowed.includes(symbol)) {
      return {
        outcome: "shadow",
        reason: symbol
          ? `${signal.asset} maps to ${symbol}, which this mandate can't hold yet`
          : `${signal.asset} isn't on Arc yet (no mapping in the registry)`,
      };
    }
    if (!status.canTrade) {
      return { outcome: "skipped", reason: status.frozen ? "the mandate is frozen" : "the mandate can't trade right now (expired or stale price)" };
    }

    const held = (sym) => status.holdings.find((h) => h.symbol === sym) ?? { amount: 0, valueUsd: 0 };
    const cap = status.rules.maxTradeUsd;

    // A size that rounds down to nothing is skipped, never sent as a zero trade.
    const worthSending = (amount) => Number(amount) > 0;

    if (signal.side === "buy") {
      const cash = held(base).amount;
      const want = signal.sizeUsd ?? cap;
      const size = Math.min(want, cap, cash);
      const amount = floorAmount(size);
      if (!worthSending(amount)) return { outcome: "skipped", reason: "no cash left to buy with" };
      return { trade: { from: base, to: symbol, amount }, clamped: size < want };
    }

    // sell
    const pos = held(symbol);
    const amount = pos.amount * (signal.fraction ?? 1);
    if (!worthSending(floorAmount(amount))) return { outcome: "skipped", reason: `no ${symbol} to sell` };
    // Without a price the per-trade cap can't be applied, so don't sell blind.
    const price = pos.valueUsd ? pos.valueUsd / pos.amount : null;
    if (price === null) return { outcome: "skipped", reason: `no price for ${symbol} right now, so it won't sell without knowing the value` };
    if (amount * price > cap) {
      return { trade: { from: symbol, to: base, amount: floorAmount(cap / price) }, clamped: true };
    }
    return { trade: { from: symbol, to: base, amount: floorAmount(amount) }, clamped: false };
  }

  return {
    mode,
    async handle(signal) {
      if (!signal) return null;
      if (ledger.has(signal.id) || inFlight.has(signal.id)) {
        return record(signal, { outcome: "duplicate", reason: "this signal was already handled" });
      }
      inFlight.add(signal.id);
      try {
        const p = await plan(signal);
        if (p.outcome) return record(signal, p);
        if (mode === "shadow") {
          return record(signal, { outcome: "shadow", reason: "shadow mode: nothing was sent", intended: p.trade, clamped: p.clamped });
        }
        try {
          const done = await client.trade(p.trade);
          return record(signal, { outcome: "traded", trade: p.trade, clamped: p.clamped, hash: done.hash, sold: done.sold, bought: done.bought });
        } catch (err) {
          if (err.mandate) {
            return record(signal, { outcome: "refused", trade: p.trade, rule: err.mandate.rule, reason: err.mandate.reason, hash: err.hash });
          }
          // Sent but not confirmed: it may have happened. Record the hash to
          // check, and never resend it; a second send could double the trade.
          if (err.hash) {
            return record(signal, { outcome: "unknown", trade: p.trade, hash: err.hash, reason: `${err.message}. Check the hash on the explorer.` });
          }
          throw err;
        }
      } finally {
        inFlight.delete(signal.id);
      }
    },
  };
}
