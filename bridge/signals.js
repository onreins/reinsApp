/**
 * Turn what a strategy "brain" says into one shape the executor understands:
 *
 *   { source, id, side: "buy"|"sell"|"hold"|"none", asset, quote,
 *     sizeUsd?, fraction?, reason }
 *
 * "none" means the brain asked for something a mandate can't do (a short, an
 * unreadable decision); the executor records it and does nothing.
 */
import { parsePair } from "./registry.js";

/**
 * A freqtrade webhook (see bridge/freqtrade.webhook.json for the config that
 * produces it). Entries become buys sized by the stake; exits sell the whole
 * position. Cancels and status pings return null: nothing to do.
 */
export function fromFreqtrade(p) {
  const type = String(p?.type ?? "");
  const entry = type === "entry" || type === "entry_fill";
  const exit = type === "exit" || type === "exit_fill";
  if (!entry && !exit) return null;
  if (p.trade_id === undefined || !p.pair) throw new Error("freqtrade webhook needs trade_id and pair");

  const { base, quote } = parsePair(p.pair);
  const signal = {
    source: "freqtrade",
    // One id per trade leg, so a retried webhook (or both "entry" and
    // "entry_fill" arriving) can't trade twice.
    id: `freqtrade:${p.trade_id}:${entry ? "entry" : "exit"}`,
    asset: base,
    quote,
  };
  if (String(p.direction ?? "long").toLowerCase() === "short") {
    return { ...signal, side: "none", reason: "short positions can't be held in a spot mandate" };
  }
  if (entry) {
    const size = Number(p.stake_amount);
    return {
      ...signal,
      side: "buy",
      sizeUsd: Number.isFinite(size) && size > 0 ? size : undefined,
      reason: `freqtrade entry${p.enter_tag ? ` (${p.enter_tag})` : ""}`,
    };
  }
  return { ...signal, side: "sell", fraction: 1, reason: `freqtrade exit${p.exit_reason ? ` (${p.exit_reason})` : ""}` };
}

/**
 * A plain decision, e.g. from the TradingAgents runner:
 *   { source, ticker, decision: "BUY" | "...SELL..." | "HOLD", sizeUsd?, id? }
 * TradingAgents answers in prose, so the first BUY/SELL/HOLD word wins.
 */
export function fromDecision(d) {
  if (!d || typeof d.ticker !== "string" || !d.ticker.trim()) throw new Error("decision needs a ticker");
  if (typeof d.decision !== "string") throw new Error("decision needs a decision string");
  const word = d.decision.toUpperCase().match(/\b(BUY|SELL|HOLD)\b/)?.[1];
  const { base, quote } = parsePair(d.ticker);
  const source = typeof d.source === "string" && d.source ? d.source.slice(0, 64) : "decision";
  const size = Number(d.sizeUsd);
  // Without an explicit id, one decision per source, asset and answer per UTC
  // day: an HTTP retry of the same decision is then a duplicate, not a second
  // trade. Send your own `id` to act more than once a day.
  const day = new Date().toISOString().slice(0, 10);
  const id = typeof d.id === "string" && d.id ? d.id.slice(0, 200) : `${source}:${base}:${word ?? "NONE"}:${day}`;
  return {
    source,
    id,
    side: word ? word.toLowerCase() : "none",
    asset: base,
    quote,
    sizeUsd: Number.isFinite(size) && size > 0 ? size : undefined,
    fraction: word === "SELL" ? 1 : undefined,
    reason: word ? `${source} said ${word}` : `${source}'s decision had no BUY, SELL or HOLD in it`,
  };
}
