/* The strategy page's numbers, kept apart from its drawing so they can be
   tested: rebasing a backtest to a start date, drawdowns, the low point,
   whether an agent's loss limit would have frozen it, and the year-bar scale.
   A plain browser script; test/strategy-math.test.js loads it in a sandbox. */
window.ReinsStrategyMath = (function () {
  "use strict";

  var LOSS_MIN = 10, LOSS_MAX = 50, LOSS_STEP = 5, LOSS_HEADROOM = 5;
  var OUTLIER = 2;       // a year more than twice the next is clipped
  var CAP_ROOM = 1.15;   // headroom above the largest ordinary year
  var CAP_MIN = 0.1;

  /** Growth of $1 from the first point on or after `from` (unix seconds). */
  function rebase(curve, from) {
    var pts = (curve || []).filter(function (p) { return p.t >= from; });
    if (!pts.length) return [];
    var base = pts[0].index;
    return pts.map(function (p) { return { t: p.t, v: p.index / base }; });
  }

  /** How far each value sits below the highest value so far: 0, or negative. */
  function drawdowns(vals) {
    var peak = -Infinity;
    return vals.map(function (v) {
      peak = Math.max(peak, v);
      return v / peak - 1;
    });
  }

  /** The lowest point of a rebased curve. */
  function lowest(pts) {
    return pts.reduce(function (low, p) { return !low || p.v < low.v ? p : low; }, null);
  }

  /**
   * Where a mandate with this loss limit would first have frozen. Its floor is
   * measured from the deposit (the contract's baseline), not from a peak.
   */
  function freezeAt(pts, limitPercent) {
    var floor = 1 - limitPercent / 100;
    // Strictly below, as in Mandate.sol: equity exactly on the floor is not frozen.
    for (var i = 0; i < pts.length; i++) if (pts[i].v < floor) return pts[i];
    return null;
  }

  /** A loss limit a little beyond the worst backtested drop, so ordinary swings don't freeze the agent. */
  function lossLimit(maxDrawdown) {
    // Rounded first: 0.15 * 100 is 15.000000000000002, which would ceil a whole step too high.
    var drop = Math.round(Math.abs(maxDrawdown) * 100 * 1e6) / 1e6;
    var pct = Math.ceil((drop + LOSS_HEADROOM) / LOSS_STEP) * LOSS_STEP;
    return Math.min(LOSS_MAX, Math.max(LOSS_MIN, pct));
  }

  /** The bar scale for years: a lone huge year is clipped so the others stay readable. */
  function yearCap(strategy, bench) {
    var sizes = strategy.map(function (v, i) { return Math.max(Math.abs(v), Math.abs(bench[i] || 0)); })
      .sort(function (a, b) { return b - a; });
    var top = sizes[0] || 0, next = sizes[1] || 0;
    var cap = sizes.length > 2 && next > 0 && top > OUTLIER * next ? next * CAP_ROOM : top;
    return Math.max(CAP_MIN, cap);
  }

  /**
   * One year's two bars against the scale. A year past the cap is shrunk as a
   * pair, so the larger bar fills the scale and the smaller keeps its share:
   * clipping each bar alone would draw two very different years as a tie.
   */
  function yearBars(strategy, bench, cap) {
    var big = Math.max(Math.abs(strategy), Math.abs(bench));
    if (big <= cap) return { s: strategy, b: bench, scaled: false };
    var fit = function (v) { return Math.abs(v) === big ? Math.sign(v) * cap : v * (cap / big); };
    return { s: fit(strategy), b: fit(bench), scaled: true };
  }

  return { yearBars: yearBars, rebase: rebase, drawdowns: drawdowns, lowest: lowest, freezeAt: freezeAt, lossLimit: lossLimit, yearCap: yearCap };
})();
