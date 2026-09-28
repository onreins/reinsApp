/**
 * A plain daily backtester for chat-built strategies.
 *
 * Deliberately simple and honest: long-only spot, one asset, daily candles.
 * Signals are read at a day's close and filled at the next day's open, so a
 * strategy never trades on a price it couldn't have seen. Every fill pays
 * `feeBps` (pool fee plus slippage). Stop-losses and take-profits fill at
 * their level, or at the open if the price gapped through it. Indicators warm
 * up on the days before the chosen start, so the first day already has them.
 *
 * Every number the chat shows comes from here, never from the model.
 */

const DAY = 86_400;

// ---------------------------------------------------------------- indicators

/** Simple moving average; NaN until n values exist. */
export function sma(x, n) {
  const out = new Array(x.length).fill(NaN);
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
  const out = new Array(x.length).fill(NaN);
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
  const out = new Array(x.length).fill(NaN);
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

/** Highest value of the previous n days, today excluded, so a close can break above it. */
export function highestPrev(x, n) {
  const out = new Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) {
    let m = -Infinity;
    for (let j = i - n; j < i; j++) if (x[j] > m) m = x[j];
    out[i] = m;
  }
  return out;
}

/** Lowest value of the previous n days, today excluded. */
export function lowestPrev(x, n) {
  const out = new Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) {
    let m = Infinity;
    for (let j = i - n; j < i; j++) if (x[j] < m) m = x[j];
    out[i] = m;
  }
  return out;
}

function seriesOf(s, k) {
  switch (s.kind) {
    case "price": return k.c;
    case "sma": return sma(k.c, s.period);
    case "ema": return ema(k.c, s.period);
    case "rsi": return rsi(k.c, s.period);
    case "highest": return highestPrev(k.h, s.period);
    case "lowest": return lowestPrev(k.l, s.period);
    case "value": return new Array(k.c.length).fill(s.value);
    default: throw new Error(`unknown series ${s.kind}`);
  }
}

/** Conditions compiled to (i) => boolean over the candles; unknown values are never true. */
function compile(conditions, k) {
  const cache = new Map();
  const get = (s) => {
    const key = JSON.stringify(s);
    if (!cache.has(key)) cache.set(key, seriesOf(s, k));
    return cache.get(key);
  };
  return conditions.map((c) => {
    const L = get(c.left), R = get(c.right);
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

const isoDay = (day) => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const dayOf = (iso) => Math.floor(Date.parse(iso + "T00:00:00Z") / 1000 / DAY);

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

/** Weekly points (plus the last day) as { t, index }, t in unix seconds. */
function weekly(days, values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i % 7 === 0 || i === values.length - 1) out.push({ t: days[i] * DAY, index: values[i] });
  }
  return out;
}

// ----------------------------------------------------------------- the run

/**
 * @param {object} spec     a parsed spec (see spec.js)
 * @param {object} k        { d, o, h, l, c } daily candles, d = days since 1970
 * @param {object} [opts]   { from: "YYYY-MM-DD", feeBps }
 */
export function backtest(spec, k, { from = "2021-01-01", feeBps = 10 } = {}) {
  const n = k.c.length;
  const fromDay = dayOf(from);
  const start = k.d.findIndex((d) => d >= fromDay);
  if (start < 0 || start >= n - 1) throw new Error(`no prices for ${spec.asset} from ${from}`);
  const fee = feeBps / 10_000;
  const days = k.d[n - 1] - k.d[start] + 1;

  // Holding: buy at the first open, pay the same entry fee.
  const holdVals = [];
  for (let i = start; i < n; i++) holdVals.push(k.c[i] / (k.o[start] * (1 + fee)));

  const base = { asset: spec.asset, from: isoDay(k.d[start]), to: isoDay(k.d[n - 1]), days, feeBps };
  const dayList = k.d.slice(start);

  if (spec.type === "dca") {
    const when = compile(spec.only_when, k);
    let units = 0, invested = 0, buys = 0;
    const ratio = [];
    for (let i = start; i < n; i++) {
      const due = (i - start) % spec.every_days === 0;
      // The filter reads yesterday's close, like every other signal.
      if (due && (!when.length || (i > 0 && all(when, i - 1)))) {
        units += 1 / (k.o[i] * (1 + fee));
        invested += 1;
        buys += 1;
      }
      ratio.push(invested > 0 ? (units * k.c[i]) / invested : 1);
    }
    return {
      ...base,
      strategy: { ...summary(ratio, days), trades: buys, winRate: null, exposure: 1 },
      hold: summary(holdVals, days),
      dca: { buys, invested, value: units * k.c[n - 1] },
      recent: [],
      curve: weekly(dayList, ratio),
      bench: weekly(dayList, holdVals),
    };
  }

  const entry = compile(spec.entry, k);
  const exit = compile(spec.exit, k);
  const size = spec.position_pct / 100;
  let cash = 1, units = 0, entryPx = 0, entryDay = 0, cost = 0;
  let pending = null, armed = true, inDays = 0;
  const trades = [];
  const equity = [];

  const buy = (i, px) => {
    const spend = cash * size;
    units = spend / (px * (1 + fee));
    cash -= spend;
    cost = spend;
    entryPx = px;
    entryDay = k.d[i];
  };
  const sell = (i, px) => {
    const proceeds = units * px * (1 - fee);
    trades.push({ in: isoDay(entryDay), out: isoDay(k.d[i]), ret: proceeds / cost - 1, open: false });
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

    // Stops first: when both levels sit inside the day's range, assume the worse happened.
    if (units > 0 && spec.stop_loss_pct) {
      const stop = entryPx * (1 - spec.stop_loss_pct / 100);
      if (k.l[i] <= stop) { sell(i, Math.min(k.o[i], stop)); armed = false; }
    }
    if (units > 0 && spec.take_profit_pct) {
      const target = entryPx * (1 + spec.take_profit_pct / 100);
      if (k.h[i] >= target) { sell(i, Math.max(k.o[i], target)); armed = false; }
    }

    equity.push(cash + units * k.c[i]);
    if (units > 0) inDays += 1;
    if (i < n - 1) pending = signal(i);
  }
  if (units > 0) {
    trades.push({ in: isoDay(entryDay), out: null, ret: (units * k.c[n - 1]) / cost - 1, open: true });
  }

  const closed = trades.filter((t) => !t.open);
  return {
    ...base,
    strategy: {
      ...summary(equity, days),
      trades: trades.length,
      winRate: closed.length ? closed.filter((t) => t.ret > 0).length / closed.length : null,
      exposure: inDays / equity.length,
    },
    hold: summary(holdVals, days),
    recent: trades.slice(-10).reverse(),
    curve: weekly(dayList, equity),
    bench: weekly(dayList, holdVals),
  };
}
