/**
 * A worker thread for runner.js: backtests on minute prices, one at a time,
 * keeping the last few coins' minutes loaded between jobs.
 */
import { parentPort, workerData } from "node:worker_threads";

import { createMinuteStore } from "./candles.js";
import { backtest } from "./backtest.js";

const store = createMinuteStore(workerData.dir, { keep: workerData.keep });

parentPort.on("message", ({ id, spec, from, feeBps }) => {
  try {
    const feed = store.feed(spec.asset);
    if (!feed) {
      parentPort.postMessage({ id, error: { unavailable: true } });
      return;
    }
    parentPort.postMessage({ id, result: backtest(spec, feed, { from, feeBps }) });
  } catch (err) {
    parentPort.postMessage({ id, error: { message: err.message } });
  }
});
