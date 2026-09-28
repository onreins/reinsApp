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

const period = (max) => z.number().int().min(2).max(max);

export const Series = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price") }).strict(),
  z.object({ kind: z.literal("sma"), period: period(400) }).strict(),
  z.object({ kind: z.literal("ema"), period: period(400) }).strict(),
  z.object({ kind: z.literal("rsi"), period: period(100) }).strict(),
  z.object({ kind: z.literal("highest"), period: period(400) }).strict(),
  z.object({ kind: z.literal("lowest"), period: period(400) }).strict(),
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

// ---------------------------------------------------------------- in words

function seriesWords(s) {
  switch (s.kind) {
    case "price": return "the price";
    case "sma": return `the ${s.period}-day average`;
    case "ema": return `the ${s.period}-day EMA`;
    case "rsi": return `RSI(${s.period})`;
    case "highest": return `the ${s.period}-day high`;
    case "lowest": return `the ${s.period}-day low`;
    case "value": return String(s.value);
  }
}
const OPS = { above: "is above", below: "is below", crosses_above: "crosses above", crosses_below: "crosses below" };

export function conditionWords(c) {
  return `${seriesWords(c.left)} ${OPS[c.op]} ${seriesWords(c.right)}`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** A spec as a few plain sentences, for the strategy panel. */
export function describeSpec(spec) {
  if (spec.type === "dca") {
    const out = [`Buy ${spec.asset} every ${spec.every_days === 1 ? "day" : spec.every_days + " days"}.`];
    if (spec.only_when.length) out.push(`Only when ${spec.only_when.map(conditionWords).join(" and ")}.`);
    return out;
  }
  const out = [`Buy ${spec.asset} when ${spec.entry.map(conditionWords).join(" and ")}.`];
  if (spec.exit.length) out.push(`Sell when ${spec.exit.map(conditionWords).join(" or ")}.`);
  else out.push("Sell when that stops being true.");
  if (spec.stop_loss_pct) out.push(`Stop-loss ${spec.stop_loss_pct}% below the entry.`);
  if (spec.take_profit_pct) out.push(`Take profit ${spec.take_profit_pct}% above the entry.`);
  if (spec.position_pct < 100) out.push(`Use ${spec.position_pct}% of the money per trade.`);
  return out.map(cap);
}
