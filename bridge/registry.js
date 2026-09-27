/**
 * Which outside symbols map to which tokens in a mandate.
 *
 * Strategies speak exchange language ("BTC/USDT", "NVDA"); a mandate speaks
 * token symbols ("EURC", later "NVDAx"). The registry is the translation. A
 * symbol that maps to nothing, or to a token this mandate doesn't hold yet,
 * is not an error: its signals are recorded as shadow trades until the asset
 * lists on Arc and the mapping is added.
 */

/** "BTC/USDT" → { base: "BTC", quote: "USDT" }; futures "ETH/USDC:USDC" too; "NVDA" → quote USD. */
export function parsePair(pair) {
  const text = String(pair ?? "").trim().toUpperCase();
  if (!text) throw new Error("empty pair");
  const [market] = text.split(":");
  const [base, quote] = market.split("/");
  return { base, quote: quote || "USD" };
}

/**
 * @param {{ quotes: string[], map: Record<string, string|null> }} config
 *   quotes: symbols that mean "dollars" (the mandate's base);
 *   map: outside symbol → mandate token symbol.
 */
export function createRegistry({ quotes = ["USD", "USDT", "USDC"], map = {} } = {}) {
  const Q = new Set(quotes.map((q) => q.toUpperCase()));
  const M = new Map(Object.entries(map).map(([k, v]) => [k.toUpperCase(), v]));
  return {
    isQuote: (symbol) => Q.has(String(symbol).toUpperCase()),
    symbolFor: (symbol) => M.get(String(symbol).toUpperCase()) ?? null,
  };
}
