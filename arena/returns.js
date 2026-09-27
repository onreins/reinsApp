/**
 * Return since funding, measured the way funds measure it: chained between
 * money movements.
 *
 * The contract's own ratio, equity / baseline, is right between movements
 * but not across them. `unfreeze()` re-anchors the baseline to equity, so a
 * frozen mandate's loss vanishes from the ratio; a deposit adds to the
 * baseline, so an earlier gain gets diluted. Here each movement is a `reset`
 * point that counts as zero performance, and the performance between
 * movements is multiplied together. For that to be exact the series also
 * samples each movement's block just before it (see app/server.js).
 *
 * Each point gains `index`: what $1 put in at funding is worth now.
 */

/**
 * @param {{ equityUsd: number, baselineUsd: number, reset?: boolean }[]} points  oldest first
 * @returns new points, each with `index`; the input is left untouched
 */
export function chainIndex(points) {
  let index = 1;
  let prev = null; // the last measurable equity / baseline ratio
  return points.map((p) => {
    const ratio = p.baselineUsd > 0 ? p.equityUsd / p.baselineUsd : null;
    // A reset changes the ratio without anyone gaining or losing: skip it.
    // An unmeasurable point (baseline 0: closed, or not yet funded) breaks the
    // chain, so the next funding starts from the record so far, not from zero.
    if (ratio !== null && prev !== null && !p.reset) index *= ratio / prev;
    prev = ratio;
    return { ...p, index };
  });
}

/** The events that move money in or out, or re-anchor the baseline. */
export const RESET_EVENTS = new Set(["Deposited", "Withdrawn", "AssetRemoved", "Unfrozen"]);
