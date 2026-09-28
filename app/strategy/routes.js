/**
 * The strategy chat's HTTP surface, mounted by app/server.js.
 *
 *   GET  /api/chat/status   is a model connected, and what can it trade
 *   POST /api/chat          { messages, spec, from } -> { reply, spec, words, backtest, source }
 *   POST /api/backtest      { spec, from }           -> { words, backtest }
 *
 * The free model keys are shared by every visitor, so model calls are rate
 * limited per visitor and in total; past either limit the chat answers from
 * its offline builder instead of refusing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ASSETS, parseSpec, describeSpec } from "./spec.js";
import { backtest } from "./backtest.js";
import { respond } from "./chat.js";
import { createLlm } from "./llm.js";

export const RANGES = ["2019-01-01", "2021-01-01", "2024-01-01"];
const DEFAULT_FROM = "2021-01-01";
const MAX_MESSAGES = 40;

const here = path.dirname(fileURLToPath(import.meta.url));
let prices = null;
/** Daily candles per coin, read once from app/data/prices.json. */
export function loadPrices(file = path.join(here, "..", "data", "prices.json")) {
  prices ??= JSON.parse(readFileSync(file, "utf8")).coins;
  return prices;
}

/** A sliding-window counter: take(key) is false once `max` hits land within `windowMs`. */
export function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(t);
      hits.set(key, list);
      // Forget idle visitors so the map can't grow without bound.
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k);
      return true;
    },
  };
}

const bad = (res, message) => res.status(400).json({ error: message });

export function mountStrategy(app, {
  llm = createLlm(),
  candles = loadPrices,
  perVisitor = createLimiter({ max: 20, windowMs: 10 * 60_000 }),
  modelBudget = createLimiter({ max: 400, windowMs: 60 * 60_000 }),
  backtests = createLimiter({ max: 60, windowMs: 60_000 }),
} = {}) {
  const run = (spec, from) => {
    const range = RANGES.includes(from) ? from : DEFAULT_FROM;
    return { words: describeSpec(spec), backtest: backtest(spec, candles()[spec.asset], { from: range }) };
  };

  app.get("/api/chat/status", (_req, res) => {
    res.json({ model: llm.connected ? llm.name : null, assets: ASSETS, ranges: RANGES });
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, spec: current, from } = req.body ?? {};
      if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return bad(res, "send the conversation as a list of messages");
      if (!perVisitor.take(req.ip)) return res.status(429).json({ error: "That's a lot of messages. Give it a few minutes and try again." });

      // A strategy the page kept from before (say, from an older version of the
      // schema) may no longer be valid: start fresh, and tell the page to drop it.
      const parsed = current ? parseSpec(current) : null;
      const spec = parsed?.ok ? parsed.spec : null;
      const specReset = Boolean(parsed && !parsed.ok);
      // Past the shared budget, the offline builder answers instead of the model.
      const model = modelBudget.take("all") ? llm : null;
      const out = await respond({ messages, spec, llm: model });
      const result = out.spec ? run(out.spec, from) : null;
      res.json({ reply: out.reply, spec: out.spec, source: out.source, ...(specReset ? { specReset } : {}), ...(result ?? {}) });
    } catch (err) {
      console.error("[chat]", err);
      res.status(500).json({ error: "The chat hit a problem on our side. Try again." });
    }
  });

  app.post("/api/backtest", (req, res) => {
    try {
      if (!backtests.take(req.ip)) return res.status(429).json({ error: "Too many backtests at once. Try again in a minute." });
      const parsed = parseSpec(req.body?.spec);
      if (!parsed.ok) return bad(res, `that strategy isn't valid: ${parsed.error}`);
      res.json(run(parsed.spec, req.body?.from));
    } catch (err) {
      if (/no prices/.test(err.message)) return bad(res, err.message);
      console.error("[backtest]", err);
      res.status(500).json({ error: "The backtest hit a problem on our side." });
    }
  });
}
