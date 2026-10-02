/**
 * The home page's activity feed, built from what the indexer already reads.
 *
 * Each agent's events (newest first, as the indexer returns them) are tagged
 * with the agent and merged into one list, newest first. Creation has no event
 * of its own on the mandate, so it is added from the factory's record and sorts
 * below anything else the agent did in that block. Totals are counted over the
 * full histories, before the list is cut down. While any agent's history is
 * still unknown the result is `partial` and the totals are null: a count that
 * is missing agents would read as a real zero.
 */
export const ACTIVITY_LIMIT = 20;

/**
 * @param {object} p
 * @param {Array<{ address: string, name?: string, createdAtBlock: string, closed?: boolean }>} p.mandates
 * @param {Map<string, Array<{ block: string, event: string }>>} p.histories  keyed by lower-case address
 * @param {number} [p.limit]
 */
export function buildActivity({ mandates, histories, limit = ACTIVITY_LIMIT }) {
  const tagged = mandates.flatMap((m) => {
    const own = histories.get(m.address.toLowerCase()) ?? [];
    const tag = { mandate: m.address, name: m.name ?? "" };
    return [
      ...own.map((e) => ({ ...e, ...tag })),
      { block: String(m.createdAtBlock), tx: null, event: "Created", ...tag },
    ];
  });
  // Array sort is stable, so within a block each agent keeps its own order.
  const events = [...tagged].sort((a, b) => Number(b.block) - Number(a.block));
  const partial = mandates.some((m) => !histories.has(m.address.toLowerCase()));
  const count = (name) => (partial ? null : tagged.filter((e) => e.event === name).length);
  return {
    events: events.slice(0, limit),
    partial,
    totals: {
      agents: mandates.length,
      live: mandates.filter((m) => !m.closed).length,
      trades: count("Traded"),
      freezes: count("Frozen"),
    },
  };
}
