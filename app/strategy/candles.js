/**
 * Prices at any timeframe, for the backtester.
 *
 * Minute candles live outside git (hundreds of MB): one pair of files per coin
 * in `CANDLES_DIR`, written by scripts/export-candles.py.
 *   <COIN>-1m.json  { start: unix seconds of the first minute, n }
 *   <COIN>-1m.bin   Float32 open[n], high[n], low[n], close[n], little-endian,
 *                   one per minute with no gaps (missing minutes carry the last close)
 *
 * Every other timeframe is built from those minutes on UTC boundaries, so a
 * "1h" candle is 00:00-00:59 and a "1d" candle is a UTC day, like Binance's.
 * A feed hands the backtester whichever timeframe it asks for.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
const DAY = 86_400;

/** One coin's minutes, or null when this server doesn't have them. */
export function readMinutes(dir, asset) {
  if (!dir) return null;
  const meta = join(dir, `${asset}-1m.json`), bin = join(dir, `${asset}-1m.bin`);
  if (!existsSync(meta) || !existsSync(bin)) return null;
  const { start, n } = JSON.parse(readFileSync(meta, "utf8"));
  const buf = readFileSync(bin);
  if (buf.length !== n * 16) throw new Error(`${asset} minute file is ${buf.length} bytes, expected ${n * 16}`);
  // Float32Array needs a 4-byte-aligned offset; copy into a fresh buffer when it isn't.
  const aligned = buf.byteOffset % 4 === 0;
  const ab = aligned ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const base = aligned ? buf.byteOffset : 0;
  const at = (k) => new Float32Array(ab, base + k * n * 4, n);
  return { start, o: at(0), h: at(1), l: at(2), c: at(3) };
}

/** Minutes → candles of `tf`, each starting on its UTC boundary. */
export function resample(m, tf) {
  const step = TF_SEC[tf];
  const n = m.c.length;
  if (step === 60) return { t: Float64Array.from({ length: n }, (_, i) => m.start + i * 60), o: m.o, h: m.h, l: m.l, c: m.c, step };
  const first = Math.floor(m.start / step) * step;
  const count = (Math.floor((m.start + (n - 1) * 60) / step) * step - first) / step + 1;
  const t = new Float64Array(count), o = new Float64Array(count), h = new Float64Array(count), l = new Float64Array(count), c = new Float64Array(count);
  let j = -1;
  for (let i = 0; i < n; i++) {
    const b = Math.floor((m.start + i * 60) / step) * step;
    const k = (b - first) / step;
    if (k !== j) {
      j = k;
      t[j] = b; o[j] = m.o[i]; h[j] = m.h[i]; l[j] = m.l[i];
    } else {
      if (m.h[i] > h[j]) h[j] = m.h[i];
      if (m.l[i] < l[j]) l[j] = m.l[i];
    }
    c[j] = m.c[i];
  }
  return { t, o, h, l, c, step };
}

/**
 * Read a series built on `src` candles at each `dst` candle's close: the value
 * of the last `src` candle that had closed by then. A daily average therefore
 * reaches an hourly strategy only once the day is over, never mid-day.
 */
export function align(values, src, dst) {
  const out = new Float64Array(dst.t.length).fill(NaN);
  let j = -1;
  for (let i = 0; i < dst.t.length; i++) {
    const close = dst.t[i] + dst.step;
    while (j + 1 < src.t.length && src.t[j + 1] + src.step <= close) j++;
    if (j >= 0) out[i] = values[j];
  }
  return out;
}

/** A feed over one coin's minutes: any timeframe, built once and kept. */
export function minuteFeed(m) {
  const frames = new Map();
  return {
    frame(tf) {
      if (!TF_SEC[tf]) return null;
      if (!frames.has(tf)) frames.set(tf, resample(m, tf));
      return frames.get(tf);
    },
  };
}

/** A feed over the daily prices in app/data/prices.json ({ d, o, h, l, c }, d = days since 1970). */
export function dailyFeed(k) {
  const frame = { t: Float64Array.from(k.d, (d) => d * DAY), o: k.o, h: k.h, l: k.l, c: k.c, step: DAY };
  return { frame: (tf) => (tf === "1d" ? frame : null) };
}

/**
 * Minute feeds for the coins this server has, loaded on first use. Only the
 * last few coins stay in memory (about 60 MB each).
 */
export function createMinuteStore(dir, { keep = 3 } = {}) {
  const cache = new Map();
  return {
    has: (asset) => Boolean(dir) && existsSync(join(dir, `${asset}-1m.bin`)),
    feed(asset) {
      if (cache.has(asset)) {
        const f = cache.get(asset);
        cache.delete(asset);
        cache.set(asset, f); // most recent last
        return f;
      }
      const m = readMinutes(dir, asset);
      if (!m) return null;
      const f = minuteFeed(m);
      cache.set(asset, f);
      while (cache.size > keep) cache.delete(cache.keys().next().value);
      return f;
    },
  };
}
