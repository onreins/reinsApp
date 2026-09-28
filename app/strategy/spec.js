/**
 * The strategy spec: the only thing the chat's model is allowed to produce.
 *
 * A spec is data, never code. The model fills it in; this schema decides what
 * exists. Anything outside it (another asset, leverage, a field nobody asked
 * for) is refused here, before the backtester or anything else sees it.
 *
 *   rules  enter when every entry condition holds; leave when any exit
 *          condition holds (or, with none, when the entry stops holding),
 *          or at the stop-loss / take-profit.
 *   dca    buy a fixed amount every N days, optionally only when conditions hold.
 */
import { z } from "zod";

export const ASSETS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "AVAX", "LINK"];

/** Candle sizes a strategy can use. Everything under a day is built from minute prices. */
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

const period = (max) => z.number().int().min(2).max(max);
// A series' own candle size; without one it uses the strategy's timeframe.
const tf = z.enum(TIMEFRAMES).optional();

export const Series = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price") }).strict(),
  z.object({ kind: z.literal("sma"), period: period(400), tf }).strict(),
  z.object({ kind: z.literal("ema"), period: period(400), tf }).strict(),
  z.object({ kind: z.literal("rsi"), period: period(100), tf }).strict(),
  z.object({ kind: z.literal("highest"), period: period(400), tf }).strict(),
  z.object({ kind: z.literal("lowest"), period: period(400), tf }).strict(),
  z.object({ kind: z.literal("value"), value: z.number().finite().min(-1e9).max(1e9) }).strict(),
]);

const isRsi = (s) => s.kind === "rsi";
const isValue = (s) => s.kind === "value";

export const Condition = z
  .object({
    left: Series,
    op: z.enum(["above", "below", "crosses_above", "crosses_below"]),
    right: Series,
  })
  .strict()
  .refine((c) => !(isValue(c.left) && isValue(c.right)), { message: "a condition can't compare two fixed numbers" })
  // RSI lives on 0-100, prices don't: comparing them is always a mistake.
  .refine((c) => !(isRsi(c.left) || isRsi(c.right)) || [c.left, c.right].every((s) => isRsi(s) || isValue(s)), {
    message: "RSI can only be compared with a number or another RSI",
  });

const name = z.string().trim().min(1).max(48);
const asset = z.enum(ASSETS);

const RulesSpec = z
  .object({
    type: z.literal("rules"),
    name,
    asset,
    // How often the rules are checked and trades fill; daily when left out.
    timeframe: z.enum(TIMEFRAMES).optional(),
    entry: z.array(Condition).min(1).max(4),
    exit: z.array(Condition).max(4).default([]),
    stop_loss_pct: z.number().min(1).max(50).optional(),
    take_profit_pct: z.number().min(1).max(500).optional(),
    position_pct: z.number().min(5).max(100).default(100),
  })
  .strict();

const DcaSpec = z
  .object({
    type: z.literal("dca"),
    name,
    asset,
    every_days: z.number().int().min(1).max(90),
    only_when: z.array(Condition).max(2).default([]),
  })
  .strict();

export const Spec = z.discriminatedUnion("type", [RulesSpec, DcaSpec]);

/** Validate untrusted input. Returns { ok, spec } or { ok: false, error } with one short sentence. */
export function parseSpec(input) {
  const r = Spec.safeParse(input);
  if (r.success) return { ok: true, spec: r.data };
  const issue = r.error.issues[0];
  const where = issue.path.length ? issue.path.join(".") + ": " : "";
  return { ok: false, error: where + issue.message };
}

/** True when a strategy checks or reads anything shorter than a day, so it needs minute prices. */
export function needsIntraday(spec) {
  if (spec.timeframe && spec.timeframe !== "1d") return true;
  const conds = spec.type === "dca" ? spec.only_when : [...spec.entry, ...spec.exit];
  return conds.some((c) => [c.left, c.right].some((s) => s.tf && s.tf !== "1d"));
}

// ---------------------------------------------------------------- in words

// 1m, 1h and 1d read as lengths of time ("the 100-minute EMA"); the others as
// candle counts ("the 20-candle EMA on 5-minute candles").
const UNIT = { "1m": "minute", "1h": "hour", "1d": "day" };
const CANDLE = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
const EVERY = { "1m": "every minute", "5m": "every 5 minutes", "15m": "every 15 minutes", "1h": "every hour", "4h": "every 4 hours", "1d": "once a day" };
const NOUN = { sma: "average", ema: "EMA", highest: "high", lowest: "low" };

function seriesWords(s, base = "1d") {
  if (s.kind === "price") return "the price";
  if (s.kind === "value") return String(s.value);
  const t = s.tf ?? base;
  if (s.kind === "rsi") return t === "1d" ? `RSI(${s.period})` : `RSI(${s.period}) on ${CANDLE[t]} candles`;
  return UNIT[t] ? `the ${s.period}-${UNIT[t]} ${NOUN[s.kind]}` : `the ${s.period}-candle ${NOUN[s.kind]} on ${CANDLE[t]} candles`;
}
const OPS = { above: "is above", below: "is below", crosses_above: "crosses above", crosses_below: "crosses below" };

export function conditionWords(c, base = "1d") {
  return `${seriesWords(c.left, base)} ${OPS[c.op]} ${seriesWords(c.right, base)}`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** A spec as a few plain sentences, for the strategy panel. */
export function describeSpec(spec) {
  if (spec.type === "dca") {
    const out = [`Buy ${spec.asset} every ${spec.every_days === 1 ? "day" : spec.every_days + " days"}.`];
    if (spec.only_when.length) out.push(`Only when ${spec.only_when.map(conditionWords).join(" and ")}.`);
    return out;
  }
  const base = spec.timeframe ?? "1d";
  const words = (c) => conditionWords(c, base);
  const out = [`Buy ${spec.asset} when ${spec.entry.map(words).join(" and ")}.`];
  if (spec.exit.length) out.push(`Sell when ${spec.exit.map(words).join(" or ")}.`);
  else out.push("Sell when that stops being true.");
  if (spec.stop_loss_pct) out.push(`Stop-loss ${spec.stop_loss_pct}% below the entry.`);
  if (spec.take_profit_pct) out.push(`Take profit ${spec.take_profit_pct}% above the entry.`);
  if (spec.position_pct < 100) out.push(`Use ${spec.position_pct}% of the money per trade.`);
  if (base !== "1d") out.push(`Checks its rules ${EVERY[base]}.`);
  return out.map(cap);
}
