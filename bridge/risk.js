/**
 * The risk engine: plain rules between a strategy's signal and the executor.
 *
 * It only ever narrows what the mandate already allows; the contract keeps the last word
 * (per-trade cap, loss-limit freeze, oracle band). Its job is to act well before the
 * contract has to:
 *
 *   drawdown ladder   share of the loss budget used = (baseline - equity) / (baseline - floor)
 *                       below reduceAt       active    buys and sells
 *                       reduceAt .. haltAt   reducing  sells only
 *                       haltAt and above     halted    nothing, until someone looks
 *   per-asset cap     a buy may take one asset to at most maxAssetPct of equity
 *   gross cap         everything outside cash stays at most maxGrossPct of equity
 *   volatility        with volTarget, an asset's cap shrinks by min(1, volTarget / its
 *                     annualised volatility), from the injected volOf(symbol)
 *
 * Unknown prices never mean "probably fine": a buy is refused when exposure can't be valued.
 * The defaults are the ones the 2026-09-27 backtests used (ladder at 50 % / 80 %, about a
 * third per asset). Rules that failed those tests, such as per-trade stop-losses on swing
 * trades, are deliberately not here.
 */

const LEVELS = { active: "active", reducing: "reducing", halted: "halted" };

function check(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * @param {object} [o]
 * @param {number} [o.reduceAt]     share of the loss budget at which only sells are allowed
 * @param {number} [o.haltAt]       share at which all trading stops
 * @param {number} [o.maxAssetPct]  largest share of equity one asset may reach through a buy
 * @param {number} [o.maxGrossPct]  largest share of equity outside cash
 * @param {number|null} [o.volTarget]  annualised volatility each asset is sized to (e.g. 0.5)
 * @param {((symbol: string) => Promise<number|null>)|null} [o.volOf]  annualised volatility source
 */
export function createRiskEngine({ reduceAt = 0.5, haltAt = 0.8, maxAssetPct = 0.34, maxGrossPct = 1, volTarget = null, volOf = null } = {}) {
  check(reduceAt > 0 && haltAt <= 1 && reduceAt < haltAt, `reduceAt (${reduceAt}) must be above 0 and below haltAt (${haltAt}), and haltAt at most 1`);
  check(maxAssetPct > 0 && maxAssetPct <= 1, `maxAssetPct must be in (0, 1], not ${maxAssetPct}`);
  check(maxGrossPct > 0 && maxGrossPct <= 1, `maxGrossPct must be in (0, 1], not ${maxGrossPct}`);
  check(volTarget === null || (volTarget > 0 && typeof volOf === "function"), "volTarget needs a volOf(symbol) source and must be above 0");

  /** Called only with a readable equity and a positive loss budget (review() checks both first). */
  function ladder(status) {
    const budget = status.baselineUsd - status.floorUsd;
    const used = Math.max(0, (status.baselineUsd - status.equityUsd) / budget);
    const level = used >= haltAt ? LEVELS.halted : used >= reduceAt ? LEVELS.reducing : LEVELS.active;
    return { level, used };
  }

  async function capFor(symbol) {
    if (volTarget === null) return maxAssetPct;
    const vol = await volOf(symbol);
    return Number.isFinite(vol) && vol > 0 ? maxAssetPct * Math.min(1, volTarget / vol) : maxAssetPct;
  }

  function block(state, rule, reason) {
    return { allow: false, ...state, rule, reason };
  }

  return {
    config: { reduceAt, haltAt, maxAssetPct, maxGrossPct, volTarget },

    /**
     * @param {{ side: string }} signal
     * @param {string} symbol   the mandate token the signal maps to
     * @param {Awaited<ReturnType<import("../mandate/sdk.js").MandateClient["status"]>>} status
     * @returns {Promise<{allow: boolean, level: string, used: number, rule?: string, reason?: string, maxBuyUsd?: number}>}
     */
    async review(signal, symbol, status) {
      const unknown = { level: LEVELS.halted, used: 1 };
      if (!Number.isFinite(status.equityUsd)) {
        return block(unknown, "no-equity", "equity can't be read (a stale price feed), so the drawdown is unknown");
      }
      if (!(status.baselineUsd - status.floorUsd > 0)) {
        return block(unknown, "no-budget", "this mandate has no loss budget (its floor is at the baseline), so nothing can be risked");
      }
      const state = ladder(status);
      const pct = (x) => `${Math.round(x * 100)} %`;
      if (state.level === LEVELS.halted) {
        return block(state, "halted", `${pct(state.used)} of the loss budget is used (halt at ${pct(haltAt)}); trading is paused until someone reviews it`);
      }
      if (signal.side !== "buy") return { allow: true, ...state };
      if (state.level === LEVELS.reducing) {
        return block(state, "reducing", `${pct(state.used)} of the loss budget is used (reduce at ${pct(reduceAt)}); only sells are allowed`);
      }

      const unpriced = status.holdings.find((h) => h.amount > 0 && h.valueUsd === null);
      if (unpriced) return block(state, "no-price", `no price for ${unpriced.symbol}, so exposure can't be valued`);

      const equity = status.equityUsd;
      const base = status.rules.allowedAssets[0];
      const value = (sym) => status.holdings.find((h) => h.symbol === sym)?.valueUsd ?? 0;
      const gross = status.holdings.filter((h) => h.symbol !== base).reduce((s, h) => s + (h.valueUsd ?? 0), 0);
      const cap = await capFor(symbol);
      const assetRoom = cap * equity - value(symbol);
      const grossRoom = maxGrossPct * equity - gross;
      if (assetRoom <= 0) return block(state, "asset-cap", `${symbol} is already at its cap of ${pct(cap)} of equity`);
      if (grossRoom <= 0) return block(state, "gross-cap", `holdings outside cash are already at the cap of ${pct(maxGrossPct)} of equity`);
      return { allow: true, ...state, maxBuyUsd: Math.min(assetRoom, grossRoom) };
    },
  };
}

/**
 * What a vault page shows: the level, the dollar lines where the ladder acts, and each
 * non-cash asset's share, cap and room to buy. Every answer comes from `engine.review`, so
 * the page can't disagree with what the bridge would actually do.
 *
 * @param {ReturnType<typeof createRiskEngine>} engine
 * @param {object} status  MandateClient.status() or an arena leaderboard row (same shape)
 */
export async function snapshot(engine, status) {
  const [base, ...others] = status.rules.allowedAssets;
  const sells = await engine.review({ side: "sell" }, others[0] ?? base, status);
  const equity = status.equityUsd;
  const assets = [];
  for (const symbol of others) {
    const v = await engine.review({ side: "buy" }, symbol, status);
    const valueUsd = status.holdings.find((h) => h.symbol === symbol)?.valueUsd ?? null;
    assets.push({
      symbol,
      valueUsd,
      share: Number.isFinite(equity) && equity > 0 && valueUsd !== null ? valueUsd / equity : null,
      capShare: engine.config.maxAssetPct,
      roomUsd: v.allow ? v.maxBuyUsd : 0,
      canBuy: v.allow,
      why: v.allow ? null : v.reason,
      rule: v.allow ? null : v.rule,
    });
  }
  const blockedBuy = assets.find((a) => !a.canBuy);
  const canBuy = assets.some((a) => a.canBuy);
  const budget = status.baselineUsd - status.floorUsd;
  const { reduceAt, haltAt } = engine.config;
  return {
    level: sells.level,
    used: sells.used,
    canSell: sells.allow,
    canBuy,
    rule: !sells.allow ? sells.rule : !canBuy && blockedBuy ? blockedBuy.rule : null,
    reason: !sells.allow ? sells.reason : !canBuy && blockedBuy ? blockedBuy.why : null,
    lines: budget > 0
      ? { reduceAtUsd: status.baselineUsd - reduceAt * budget, haltAtUsd: status.baselineUsd - haltAt * budget, floorUsd: status.floorUsd }
      : { floorUsd: status.floorUsd },
    assets,
    config: engine.config,
  };
}
