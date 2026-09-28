/**
 * A plain backtester for chat-built strategies, on any timeframe from one
 * minute to one day.
 *
 * Deliberately simple and honest: long-only spot, one asset. Signals are read
 * at a candle's close and filled at the next candle's open, so a strategy never
 * trades on a price it couldn't have seen. Every fill pays `feeBps` (pool fee
 * plus slippage). Stop-losses and take-profits fill at their level, or at the
 * open if the price gapped through it. Indicators warm up on the candles before
 * the chosen start, so the first candle already has them.
 *
 * A series can live on another timeframe than the strategy (a 50-day average
 * read every minute); it is built on its own candles and read only once they
 * have closed (see candles.js `align`).
 *
 * Every number the chat shows comes from here, never from the model.
 */
import { align, dailyFeed } from "./candles.js";

const DAY = 86_400;

// ---------------------------------------------------------------- indicators

const nans = (n) => new Float64Array(n).fill(NaN);

/** Simple moving average; NaN until n values exist. */
export function sma(x, n) {
  const out = nans(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of its first n values. */
export function ema(x, n) {
  const out = nans(x.length);
  if (x.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < x.length; i++) out[i] = e = e + k * (x[i] - e);
  return out;
}

/** Wilder's RSI; NaN for the first n values. */
export function rsi(x, n) {
  const out = nans(x.length);
  if (x.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = x[i] - x[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

/**
 * The extreme of the previous n values, the current one left out so a close can
 * break above (or below) it. A monotonic queue keeps it linear, which minute
 * candles need: 3.7M candles × a 400-candle window would otherwise be 1.5B steps.
 */
function extremePrev(x, n, better) {
  const len = x.length, out = nans(len), q = new Int32Array(len);
  let head = 0, tail = 0;
  for (let i = 0; i < len; i++) {
    if (i >= n) {
      while (q[head] < i - n) head++;
      out[i] = x[q[head]];
    }
    while (tail > head && !better(x[q[tail - 1]], x[i])) tail--;
    q[tail++] = i;
  }
  return out;
}
/** Highest value of the previous n candles. */
export const highestPrev = (x, n) => extremePrev(x, n, (kept, next) => kept > next);
/** Lowest value of the previous n candles. */
export const lowestPrev = (x, n) => extremePrev(x, n, (kept, next) => kept < next);

function indicator(s, k) {
  switch (s.kind) {
    case "sma": return sma(k.c, s.period);
    case "ema": return ema(k.c, s.period);
    case "rsi": return rsi(k.c, s.period);
    case "highest": return highestPrev(k.h, s.period);
    case "lowest": return lowestPrev(k.l, s.period);
    default: throw new Error(`unknown series ${s.kind}`);
  }
}

/** Conditions compiled to (i) => boolean over the base candles; unknown values are never true. */
function compile(conditions, series) {
  return conditions.map((c) => {
    const L = series(c.left), R = series(c.right);
    const ok = (i) => Number.isFinite(L[i]) && Number.isFinite(R[i]);
    switch (c.op) {
      case "above": return (i) => ok(i) && L[i] > R[i];
      case "below": return (i) => ok(i) && L[i] < R[i];
      case "crosses_above": return (i) => i > 0 && ok(i) && ok(i - 1) && L[i - 1] <= R[i - 1] && L[i] > R[i];
      case "crosses_below": return (i) => i > 0 && ok(i) && ok(i - 1) && L[i - 1] >= R[i - 1] && L[i] < R[i];
      default: throw new Error(`unknown op ${c.op}`);
    }
  });
}
const all = (fs, i) => fs.every((f) => f(i));
const any = (fs, i) => fs.some((f) => f(i));

// ------------------------------------------------------------------ metrics

const isoDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const isoMinute = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

function maxDrawdown(values) {
  let peak = -Infinity, worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

function summary(values, days) {
  const end = values[values.length - 1];
  return {
    return: end - 1,
    cagr: days >= 30 && end > 0 ? Math.pow(end, 365 / days) - 1 : null,
    maxDrawdown: maxDrawdown(values),
  };
}

/** About one point a week (plus the last), as { t, index }, t in unix seconds. */
function weekly(t, values, step) {
  const every = Math.max(1, Math.round((7 * DAY) / step));
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i % every === 0 || i === values.length - 1) out.push({ t: t[i], index: values[i] });
  }
  return out;
}

/** The first index with t >= at, by binary search (minute series are long). */
function firstAtOrAfter(t, at) {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < at) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ----------------------------------------------------------------- the run

/**
 * @param {object} spec     a parsed spec (see spec.js)
 * @param {object} source   a feed ({ frame(tf) } from candles.js), or daily
 *                          candles { d, o, h, l, c } with d = days since 1970
 * @param {object} [opts]   { from: "YYYY-MM-DD", feeBps }
 */
export function backtest(spec, source, { from = "2021-01-01", feeBps = 10 } = {}) {
  const feed = typeof source.frame === "function" ? source : dailyFeed(source);
  // DCA schedules in days; rules check on their own timeframe.
  const baseTf = spec.type === "dca" ? "1d" : spec.timeframe ?? "1d";
  const frameOf = (tf) => {
    const f = feed.frame(tf);
    if (!f || f.t.length < 2) throw new Error(`no ${tf} prices for ${spec.asset}`);
    return f;
  };
  const k = frameOf(baseTf);
  const n = k.c.length, step = k.step;
  const stamp = step < DAY ? isoMinute : isoDate;

  const start = firstAtOrAfter(k.t, Date.parse(from + "T00:00:00Z") / 1000);
  if (start >= n - 1) throw new Error(`no prices for ${spec.asset} from ${from}`);
  const fee = feeBps / 10_000;
  const days = (k.t[n - 1] - k.t[start] + step) / DAY;

  // Each series once, on its own candles, then read at the base candles' closes.
  const cache = new Map();
  const series = (s) => {
    if (s.kind === "price") return k.c;
    if (s.kind === "value") return new Float64Array(n).fill(s.value);
    const key = JSON.stringify(s);
    if (!cache.has(key)) {
      const tf = s.tf ?? baseTf;
      if (tf === baseTf) cache.set(key, indicator(s, k));
      else {
        const src = frameOf(tf);
        cache.set(key, align(indicator(s, src), src, k));
      }
    }
    return cache.get(key);
  };

  // Holding: buy at the first open, pay the same entry fee.
  const holdVals = new Float64Array(n - start);
  for (let i = start; i < n; i++) holdVals[i - start] = k.c[i] / (k.o[start] * (1 + fee));

  const base = { asset: spec.asset, timeframe: baseTf, from: isoDate(k.t[start]), to: isoDate(k.t[n - 1]), days, feeBps };
  const times = k.t.subarray(start);

  if (spec.type === "dca") {
    const when = compile(spec.only_when, series);
    let units = 0, invested = 0, buys = 0;
    const ratio = new Float64Array(n - start);
    for (let i = start; i < n; i++) {
      const due = (i - start) % spec.every_days === 0;
      // The filter reads yesterday's close, like every other signal.
      if (due && (!when.length || (i > 0 && all(when, i - 1)))) {
        units += 1 / (k.o[i] * (1 + fee));
        invested += 1;
        buys += 1;
      }
      ratio[i - start] = invested > 0 ? (units * k.c[i]) / invested : 1;
    }
    return {
      ...base,
      strategy: { ...summary(ratio, days), trades: buys, winRate: null, exposure: 1 },
      hold: summary(holdVals, days),
      dca: { buys, invested, value: units * k.c[n - 1] },
      recent: [],
      curve: weekly(times, ratio, step),
      bench: weekly(times, holdVals, step),
    };
  }

  const entry = compile(spec.entry, series);
  const exit = compile(spec.exit, series);
  const size = spec.position_pct / 100;
  let cash = 1, units = 0, entryPx = 0, entryT = 0, cost = 0;
  let pending = null, armed = true, inBars = 0;
  const trades = [];
  const equity = new Float64Array(n - start);

  const buy = (i, px) => {
    const spend = cash * size;
    units = spend / (px * (1 + fee));
    cash -= spend;
    cost = spend;
    entryPx = px;
    entryT = k.t[i];
  };
  const sell = (i, px) => {
    const proceeds = units * px * (1 - fee);
    trades.push({ in: stamp(entryT), out: stamp(k.t[i]), ret: proceeds / cost - 1, open: false });
    cash += proceeds;
    units = 0;
  };
  // A stop-out disarms the entry until it stops holding, so a stop can't be bought straight back.
  const signal = (i) => {
    const e = all(entry, i);
    if (!e) armed = true;
    if (units === 0) return e && armed ? "buy" : null;
    return (exit.length ? any(exit, i) : !e) ? "sell" : null;
  };
  // A signal on the close before the start fills at the start's open.
  if (start > 0) pending = signal(start - 1);

  for (let i = start; i < n; i++) {
    if (pending === "buy" && units === 0) buy(i, k.o[i]);
    else if (pending === "sell" && units > 0) sell(i, k.o[i]);
    pending = null;

    // Stops first: when both levels sit inside the candle's range, assume the worse happened.
    if (units > 0 && spec.stop_loss_pct) {
      const stop = entryPx * (1 - spec.stop_loss_pct / 100);
      if (k.l[i] <= stop) { sell(i, Math.min(k.o[i], stop)); armed = false; }
    }
    if (units > 0 && spec.take_profit_pct) {
      const target = entryPx * (1 + spec.take_profit_pct / 100);
      if (k.h[i] >= target) { sell(i, Math.max(k.o[i], target)); armed = false; }
    }

    equity[i - start] = cash + units * k.c[i];
    if (units > 0) inBars += 1;
    if (i < n - 1) pending = signal(i);
  }
  if (units > 0) {
    trades.push({ in: stamp(entryT), out: null, ret: (units * k.c[n - 1]) / cost - 1, open: true });
  }

  let wins = 0, closedCount = 0;
  for (const t of trades) if (!t.open) { closedCount += 1; if (t.ret > 0) wins += 1; }
  return {
    ...base,
    strategy: {
      ...summary(equity, days),
      trades: trades.length,
      winRate: closedCount ? wins / closedCount : null,
      exposure: inBars / equity.length,
    },
    hold: summary(holdVals, days),
    recent: trades.slice(-10).reverse(),
    curve: weekly(times, equity, step),
    bench: weekly(times, holdVals, step),
  };
}
