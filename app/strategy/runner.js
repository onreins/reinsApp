/**
 * Runs backtests for the chat without stalling the server.
 *
 * Daily strategies are quick (a few ms on ~2,500 candles) and run in-process.
 * Anything on minute prices walks up to ~4M candles (~0.3 s of CPU and ~150 MB
 * of scratch memory), so it runs on a small pool of worker threads instead:
 *
 *   - each coin always goes to the same worker, so its minutes load once;
 *   - past `maxQueue` jobs waiting or running, new ones get Busy, not a pile-up;
 *   - a job past `timeoutMs` is stopped by restarting its worker;
 *   - results are cached by (strategy, start, fee), and identical requests
 *     already running share one run.
 *
 * With `minutes` (a store from candles.js) minute jobs run in-process instead,
 * which is what the HTTP tests use.
 */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

import { ASSETS, describeSpec, needsIntraday } from "./spec.js";
import { backtest } from "./backtest.js";
import { createMinuteStore } from "./candles.js";

/** A strategy this server can't run (no minute prices for its coin); the message says why. */
export class Unavailable extends Error {}
/** Too many minute backtests queued; try again shortly. */
export class Busy extends Error {}

const WORKER = new URL("./backtest-worker.js", import.meta.url);

function lru(max) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v);
      return v;
    },
    set(k, v) {
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value);
    },
  };
}

export function createRunner({
  candles,
  minutesDir,
  minutes,
  workers = Math.max(1, Math.min(2, availableParallelism() - 1)),
  keep = Number(process.env.CANDLES_KEEP) || 2,
  maxQueue = 12,
  timeoutMs = 30_000,
  cacheSize = 300,
} = {}) {
  const store = minutes ?? createMinuteStore(minutesDir);
  const cache = lru(cacheSize);
  const inflight = new Map();
  const slots = Array.from({ length: workers }, () => ({ worker: null, queue: [], job: null }));
  let outstanding = 0, nextId = 1;

  const unavailable = (asset) => new Unavailable(`minute prices for ${asset} aren't on this server yet, so it can only test daily rules for it`);

  // ------------------------------------------------------------- the pool
  function spawn(slot) {
    const w = new Worker(WORKER, { workerData: { dir: minutesDir, keep } });
    w.unref(); // never keep the process alive on its own
    w.on("message", ({ id, result, error }) => {
      const job = slot.job;
      if (!job || job.id !== id) return;
      if (error) job.reject(error.unavailable ? unavailable(job.spec.asset) : new Error(error.message));
      else job.resolve(result);
      finish(slot);
    });
    w.on("error", (err) => {
      if (slot.worker !== w) return;
      if (slot.job) slot.job.reject(new Error(`the backtest failed: ${err.message}`));
      slot.worker = null;
      finish(slot);
    });
    slot.worker = w;
  }
  function start(slot) {
    if (slot.job || !slot.queue.length) return;
    const job = (slot.job = slot.queue.shift());
    if (!slot.worker) spawn(slot);
    job.timer = setTimeout(() => {
      // A runaway job: stop its worker (and whatever it had loaded) and move on.
      const w = slot.worker;
      slot.worker = null;
      w?.terminate();
      job.reject(new Error("that backtest took too long, so it was stopped"));
      finish(slot);
    }, timeoutMs);
    slot.worker.postMessage({ id: job.id, spec: job.spec, from: job.from, feeBps: job.feeBps });
  }
  function finish(slot) {
    if (slot.job) {
      clearTimeout(slot.job.timer);
      slot.job = null;
      outstanding -= 1;
    }
    start(slot);
  }
  function onWorker(spec, from, feeBps) {
    if (outstanding >= maxQueue) return Promise.reject(new Busy("lots of minute backtests are running right now; try again in a few seconds"));
    outstanding += 1;
    const slot = slots[Math.max(0, ASSETS.indexOf(spec.asset)) % slots.length];
    return new Promise((resolve, reject) => {
      slot.queue.push({ id: nextId++, spec, from, feeBps, resolve, reject });
      start(slot);
    });
  }

  // ---------------------------------------------------------------- run
  async function compute(spec, from, feeBps) {
    if (!needsIntraday(spec)) return backtest(spec, candles()[spec.asset], { from, feeBps });
    if (!store.has(spec.asset)) throw unavailable(spec.asset);
    if (minutes) return backtest(spec, minutes.feed(spec.asset), { from, feeBps });
    return onWorker(spec, from, feeBps);
  }

  return {
    /** Minute prices for this coin are on this server. */
    has: (asset) => store.has(asset),

    /** { words, backtest } for a parsed spec. */
    run(spec, { from, feeBps }) {
      const key = JSON.stringify([spec, from, feeBps]);
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      if (inflight.has(key)) return inflight.get(key);
      const p = compute(spec, from, feeBps)
        .then((bt) => {
          const out = { words: describeSpec(spec), backtest: bt };
          cache.set(key, out);
          return out;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    async close() {
      await Promise.all(slots.map((s) => s.worker?.terminate()));
    },
  };
}
