/**
 * The strategy chat's conversation: plain words in, a validated spec out.
 *
 * The model only ever proposes a spec (JSON data) and a short reply. The
 * schema in spec.js decides whether the spec exists; a refused spec gets one
 * retry with the reason, then is dropped. The model never states returns:
 * the backtester computes every number the page shows.
 *
 * When there is no model, or every free provider is busy, `offlineDraft`
 * reads the common ideas (trend filter, golden cross, RSI dip, breakout, DCA)
 * so the chat still works.
 */
import { ASSETS, parseSpec } from "./spec.js";

const MAX_TURNS = 10;
const MAX_CHARS = 1500;
const MAX_REPLY = 1200;

export const SYSTEM = `You are the strategy builder inside Reins, an app where people run trading strategies as agents. People describe an idea in plain words; you turn it into a strategy spec (JSON) that the app backtests on real daily prices.

Rules for you:
- Answer with ONE JSON object and nothing else: {"reply": "...", "spec": <spec or null>}.
- "reply" is one to three short, plain sentences. Say what you built or changed, or ask one question if the idea is unclear.
- Never give investment advice, never predict prices, never promise or state returns or performance numbers. The app computes results from the backtest.
- Never ask for personal information.
- Set "spec" whenever the person has described enough to build or change a strategy. Start from the current strategy when they ask for a change. Use null when they only ask a question.
- If they ask for something a spec cannot express (shorting, leverage, stocks, several assets at once, intraday timeframes, news or sentiment), say so and offer the closest thing it can do.

A spec is one of:
1. {"type":"rules","name":"<short name>","asset":ASSET,"entry":[CONDITION,...],"exit":[CONDITION,...],"stop_loss_pct":1-50,"take_profit_pct":1-500,"position_pct":5-100}
   Buys when ALL entry conditions hold (1-4 of them). Sells when ANY exit condition holds (0-4); with no exit conditions it sells when the entry stops holding. stop_loss_pct and take_profit_pct are optional. position_pct defaults to 100.
2. {"type":"dca","name":"<short name>","asset":ASSET,"every_days":1-90,"only_when":[CONDITION,...]}
   Buys a fixed amount every N days, optionally only when 0-2 conditions hold.

ASSET is one of ${ASSETS.join(", ")}. Daily candles only.
CONDITION is {"left":SERIES,"op":"above"|"below"|"crosses_above"|"crosses_below","right":SERIES}.
SERIES is one of {"kind":"price"}, {"kind":"sma","period":2-400}, {"kind":"ema","period":2-400}, {"kind":"rsi","period":2-100}, {"kind":"highest","period":2-400}, {"kind":"lowest","period":2-400}, {"kind":"value","value":<number>}.
"highest" and "lowest" are the highest high and lowest low of the previous N days. Compare RSI only with a "value" or another RSI. Use no other fields.

Example. "Buy ETH when it's above its 200-day average" becomes
{"reply":"Here's an ETH trend filter: it holds ETH while the price is above its 200-day average and steps aside below it.","spec":{"type":"rules","name":"ETH 200-day trend","asset":"ETH","entry":[{"left":{"kind":"price"},"op":"above","right":{"kind":"sma","period":200}}],"exit":[],"position_pct":100}}`;

// ------------------------------------------------------------- the offline builder

const ASSET_WORDS = [
  [/\b(btc|bitcoin)\b/i, "BTC"], [/\b(eth|ether|ethereum)\b/i, "ETH"], [/\b(sol|solana)\b/i, "SOL"],
  [/\b(xrp|ripple)\b/i, "XRP"], [/\b(bnb|binance coin)\b/i, "BNB"], [/\b(doge|dogecoin)\b/i, "DOGE"],
  [/\b(avax|avalanche)\b/i, "AVAX"], [/\b(link|chainlink)\b/i, "LINK"],
];
const price = { kind: "price" };
const num = (s) => (s === undefined ? undefined : Number(s));

function assetIn(text) {
  for (const [re, a] of ASSET_WORDS) if (re.test(text)) return a;
  return undefined;
}
function stopIn(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:trailing\s+)?stop/i) || text.match(/stop(?:[- ]?loss)?\s*(?:at|of)?\s*(\d+(?:\.\d+)?)\s*%/i);
  return num(m?.[1]);
}
function targetIn(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:take[- ]?profit|profit target|target)/i) || text.match(/take[- ]?profit\s*(?:at|of)?\s*(\d+(?:\.\d+)?)\s*%/i);
  return num(m?.[1]);
}

/** The idea in `text`, as a rules/DCA draft without asset or risk settings. */
function ideaIn(text) {
  // Percentages are stops and targets, never periods: take them out first.
  const t = text.toLowerCase().replace(/\d+(?:\.\d+)?\s*%/g, " ");

  const dca = t.match(/\bdca\b|dollar[- ]cost|every\s+(day|week|month|(\d+)\s*days?)/);
  if (dca) {
    const every = /month/.test(t) ? 30 : /every\s+day|daily/.test(t) ? 1 : num(t.match(/every\s+(\d+)\s*days?/)?.[1]) ?? 7;
    return { type: "dca", label: every === 7 ? "weekly DCA" : every === 30 ? "monthly DCA" : `${every}-day DCA`, every_days: every, only_when: [] };
  }

  const cross = t.match(/golden cross/) ? [50, 200] : t.match(/(\d+)\s*(?:-?day)?[^.]{0,30}cross(?:es)?[^.]{0,20}?(\d+)/)?.slice(1).map(Number);
  if (cross && cross.length === 2) {
    const [a, b] = cross[0] < cross[1] ? cross : [cross[1], cross[0]];
    const kind = /\bema\b/.test(t) ? "ema" : "sma";
    return {
      type: "rules", label: t.includes("golden") ? "golden cross" : `${a}/${b} cross`,
      entry: [{ left: { kind, period: a }, op: "crosses_above", right: { kind, period: b } }],
      exit: [{ left: { kind, period: a }, op: "crosses_below", right: { kind, period: b } }],
    };
  }

  if (/\brsi\b|oversold/.test(t)) {
    const low = num(t.match(/rsi[^\d]{0,20}(?:below|under|<)\s*(\d+)/)?.[1]) ?? 30;
    const high = num(t.match(/rsi[^\d]{0,30}(?:above|over|>)\s*(\d+)/)?.[1]) ?? 70;
    const rsiS = { kind: "rsi", period: 14 };
    return {
      type: "rules", label: "RSI dip",
      entry: [{ left: rsiS, op: "below", right: { kind: "value", value: low } }],
      exit: [{ left: rsiS, op: "above", right: { kind: "value", value: high } }],
    };
  }

  if (/breakout|break(?:s|ing)?\s+(?:out|above)|new high|\d+[- ]?day high/.test(t)) {
    const n = num(t.match(/(\d+)[- ]?day high/)?.[1]) ?? 20;
    return {
      type: "rules", label: `${n}-day breakout`,
      entry: [{ left: price, op: "crosses_above", right: { kind: "highest", period: n } }],
      exit: [{ left: price, op: "crosses_below", right: { kind: "lowest", period: Math.max(2, Math.round(n / 2)) } }],
    };
  }

  const ma = t.match(/(\d+)\s*[- ]?\s*(?:day|d)\b[^.]{0,25}(?:average|\bma\b|\bsma\b|\bema\b)|(?:average|\bma\b|\bsma\b|\bema\b)[^.]{0,10}?(\d+)/);
  if (ma || /moving average|\baverage\b|trend/.test(t)) {
    const n = num(ma?.[1] ?? ma?.[2]) ?? 200;
    const kind = /\bema\b/.test(t) ? "ema" : "sma";
    return { type: "rules", label: `${n}-day trend`, entry: [{ left: price, op: "above", right: { kind, period: n } }], exit: [] };
  }
  return null;
}

/** When to sell, from a sell-only instruction ("sell when RSI is above 80"). */
function exitIn(text) {
  const t = text.toLowerCase().replace(/\d+(?:\.\d+)?\s*%/g, " ");
  const rsiHigh = t.match(/rsi[^\d]{0,30}(?:above|over|>)\s*(\d+)/);
  if (rsiHigh) return [{ left: { kind: "rsi", period: 14 }, op: "above", right: { kind: "value", value: Number(rsiHigh[1]) } }];
  const low = t.match(/(\d+)[- ]?day low/);
  if (low) return [{ left: price, op: "crosses_below", right: { kind: "lowest", period: Number(low[1]) } }];
  const ma = t.match(/(?:below|under)[^.]{0,25}?(\d+)\s*[- ]?\s*(?:day|d)\b/);
  if (ma) return [{ left: price, op: "below", right: { kind: /\bema\b/.test(t) ? "ema" : "sma", period: Number(ma[1]) } }];
  return null;
}

const HELP = "I can build a few kinds of strategy: a trend filter (\"buy ETH above its 200-day average\"), a golden cross, an RSI dip (\"buy SOL when RSI is oversold\"), a breakout above the 20-day high, or regular buying (\"DCA into BTC every week\"). Add a stop-loss like \"with a 10% stop\".";

/**
 * Read a strategy from plain words without a model.
 * @returns {{ reply: string, spec: object|null }}
 */
export function offlineDraft(text, current = null) {
  const asset = assetIn(text);
  const stop = stopIn(text);
  const target = targetIn(text);
  const sellOnly = /^\s*(?:sell|exit|close|get out)\b/i.test(text) && !/\bbuy\b/i.test(text);

  let draft;
  if (sellOnly) {
    if (!current || current.type !== "rules") return { reply: "Tell me when to buy first, then I can add when to sell.", spec: null };
    const exit = exitIn(text);
    if (!exit) return { reply: "I can sell when RSI goes above a level, when the price falls below an N-day average, or below the N-day low. " + HELP, spec: null };
    draft = { ...current, exit };
    if (stop) draft.stop_loss_pct = stop;
    if (target) draft.take_profit_pct = target;
    const r = parseSpec(draft);
    return r.ok ? { reply: `Updated when to sell for ${r.spec.name}.`, spec: r.spec } : { reply: `I couldn't build that: ${r.error}.`, spec: null };
  }

  const idea = ideaIn(text);
  if (idea) {
    const a = asset ?? current?.asset ?? "BTC";
    const { label, ...rest } = idea;
    draft = { ...rest, name: `${a} ${label}`, asset: a };
    if (draft.type === "rules") {
      if (stop) draft.stop_loss_pct = stop;
      if (target) draft.take_profit_pct = target;
    }
  } else if (current && (asset || stop || target)) {
    draft = { ...current };
    if (asset) { draft.asset = asset; draft.name = draft.name.replace(/^[A-Z]+\b/, asset); }
    if (draft.type === "rules" && stop) draft.stop_loss_pct = stop;
    if (draft.type === "rules" && target) draft.take_profit_pct = target;
  } else {
    return { reply: HELP, spec: null };
  }

  const r = parseSpec(draft);
  if (!r.ok) return { reply: `I couldn't build that: ${r.error}. ${HELP}`, spec: null };
  const changed = !idea && current;
  return { reply: changed ? `Updated your strategy: ${r.spec.name}.` : `Built "${r.spec.name}". The backtest is on the right.`, spec: r.spec };
}

// ---------------------------------------------------------------- the model

/** The last few turns, each trimmed, roles limited to user and assistant. */
export function clip(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
}

/** Pull the first JSON object out of a model's answer, fenced or not. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

const cleanReply = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, MAX_REPLY);

/**
 * One turn of the conversation.
 * @param {object} o  { messages, spec (the current one, already validated or null), llm }
 * @returns {Promise<{ reply: string, spec: object|null, source: string }>}
 */
export async function respond({ messages, spec, llm }) {
  const history = clip(messages);
  const last = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const offline = (prefix = "") => {
    const d = offlineDraft(last, spec);
    return { reply: (prefix + d.reply).slice(0, MAX_REPLY), spec: d.spec, source: "offline" };
  };
  if (!llm?.connected) return offline();

  const context = { role: "system", content: spec ? `Current strategy: ${JSON.stringify(spec)}` : "There is no strategy yet." };
  let convo = [{ role: "system", content: SYSTEM }, context, ...history];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await llm.complete(convo);
      const raw = typeof got === "string" ? got : got?.text;
      const out = extractJson(raw);
      const source = (typeof got === "object" && got?.route) || llm.name || "model";
      if (!out || typeof out.reply !== "string") {
        if (attempt === 0) { convo = [...convo, { role: "user", content: "Answer again as one JSON object: {\"reply\": \"...\", \"spec\": ... }." }]; continue; }
        return { reply: cleanReply(raw) || "Sorry, I lost my train of thought. Try saying that another way.", spec: null, source };
      }
      if (out.spec == null) return { reply: cleanReply(out.reply), spec: null, source };
      const r = parseSpec(out.spec);
      if (r.ok) return { reply: cleanReply(out.reply), spec: r.spec, source };
      if (attempt === 0) {
        convo = [...convo, { role: "assistant", content: JSON.stringify(out) }, { role: "user", content: `That spec was refused (${r.error}). Answer again with a valid spec, as one JSON object.` }];
        continue;
      }
      return { reply: cleanReply(out.reply) + " (I couldn't turn that into rules the backtester accepts, so nothing changed.)", spec: null, source };
    }
  } catch {
    return offline("The free models are busy right now, so I used the simple builder. ");
  }
  return offline();
}
