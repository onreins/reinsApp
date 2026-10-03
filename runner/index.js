/**
 * The Reins runner: trades hosted agents with the keys it holds.
 *
 *   npm run runner                 run every TICK_SECONDS until stopped
 *   npm run runner -- --once       one pass, then exit (non-zero if it failed)
 *   npm run runner:admin -- status see every hosted agent; see runner/admin.js
 *
 * Started through runner/start.js, which checks the Node version first.
 *
 * Settings are in runner/config.js; it needs Node 22.13 or later (node:sqlite).
 * To stop all trading without stopping the process, create the kill switch file
 * (KILL_SWITCH_FILE, default data/STOP); delete it to resume. GET /health says
 * what the last pass did; it listens on this machine only unless RUNNER_HOST
 * says otherwise.
 */
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { ArenaIndexer } from "../arena/indexer.js";
import { loadDeployment, loadIndexSnapshot } from "../app/server.js";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { createKeystore } from "./keystore.js";
import { createLoop } from "./loop.js";
import { createGasKeeper } from "./gas.js";
import { log, setSecrets } from "./log.js";

const SHUTDOWN_WAIT_MS = 30_000;

/** The kill switch fails closed: if its path can't be checked, trading stops. */
export function killSwitchAt(path) {
  return () => {
    try {
      statSync(path);
      return true;
    } catch (err) {
      return err?.code !== "ENOENT";
    }
  };
}

export async function startRunner(config = loadConfig(), { once = false } = {}) {
  setSecrets([config.masterKey.toString("hex"), config.secret, config.gasKey, config.gasKey.slice(2), config.rpcUrl].filter(Boolean));
  const dep = loadDeployment(config.network);
  const chain = dep.chainId === arc.id ? arc : arcTestnet;
  const transport = () => http(config.rpcUrl, { retryCount: 5, retryDelay: 800 });
  const publicClient = createPublicClient({ chain, transport: transport() });
  const walletFor = (account) => createWalletClient({ account, chain, transport: transport() });
  const chainId = await publicClient.getChainId();
  if (chainId !== dep.chainId) throw new Error(`the RPC is on chain ${chainId}, but the ${config.network} deployment is on ${dep.chainId}`);

  const store = openStore(config.dbPath);
  const stale = store.settleStale("The runner stopped mid-pass. Check the agent's transactions; it will not be resent.");
  if (stale) log.warn(`${stale} decision(s) were cut off by the last stop and are marked unknown`);
  const keystore = createKeystore({ masterKey: config.masterKey });
  const indexer = new ArenaIndexer({ publicClient, factory: dep.contracts.mandateFactory, fromBlock: BigInt(dep.fromBlock ?? 0) });
  indexer.seedLogs(loadIndexSnapshot(dep));
  const gas = createGasKeeper({ publicClient, gasWallet: walletFor(privateKeyToAccount(config.gasKey)), store });
  const killSwitch = killSwitchAt(config.killSwitchFile);
  const loop = createLoop({
    store,
    keystore,
    publicClient,
    walletFor,
    discover: () => indexer.mandates(),
    expected: { base: dep.external.usdc, venue: dep.contracts.uniswapV4Venue, assets: { [dep.external.eurc]: dep.contracts.pinnedFeed } },
    tickMs: config.tickSeconds * 1000,
    killSwitch,
    log,
  });

  const health = { startedAt: new Date().toISOString(), lastPassAt: null, lastPass: null, lastError: null, gasWallet: null };
  let inFlight = null;

  async function pass() {
    if (killSwitch()) return { killSwitch: true };
    const bound = await loop.bind();
    // Gas between the halves: a key bound just now has none, and a key that traded last pass may be low.
    for (const r of await gas.topUp(store.keys({ running: true }).map((k) => k.address))) {
      if (r.skipped || r.error) log.warn(`gas for ${r.address}: ${r.skipped ?? r.error}`);
    }
    return { ...bound, ...(await loop.run()) };
  }

  async function tick() {
    if (inFlight) return inFlight; // a slow pass is never overlapped by the next one
    inFlight = (async () => {
      try {
        const summary = await pass();
        health.gasWallet = await gas.walletBalance().catch(() => health.gasWallet);
        health.lastPassAt = new Date().toISOString();
        health.lastPass = summary;
        health.lastError = null;
        log.info(summary.killSwitch ? "kill switch is on: nothing sent" : `pass: ${JSON.stringify(summary)}`);
        return true;
      } catch (err) {
        health.lastError = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0];
        log.error("pass failed:", err);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  if (once) {
    const ok = await tick();
    store.close();
    return ok;
  }


  // Health: counts and times, never keys or settings. Stale (503) if no pass
  // has finished for three ticks, including when none ever has.
  const server = createServer((req, res) => {
    try {
      if (req.method !== "GET" || req.url !== "/health") return void res.writeHead(404).end();
      const last = Date.parse(health.lastPassAt ?? health.startedAt);
      const stale = Date.now() - last > 3 * config.tickSeconds * 1000;
      res.writeHead(stale ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...health, stale, killSwitch: killSwitch(), agents: store.countRunning(), network: config.network }));
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  // Listen first: a port already in use should stop the runner before it trades, not halfway through a pass.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  log.info(`runner on ${config.network}, every ${config.tickSeconds}s; health on ${config.host}:${config.port}/health`);
  const timer = setInterval(tick, config.tickSeconds * 1000);
  tick();

  // Let a pass in progress finish (a trade may be on its way) before closing the store.
  const stop = async () => {
    clearInterval(timer);
    server.close();
    if (inFlight) await Promise.race([inFlight, new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS))]);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A stray rejection is logged and the runner carries on; a real crash is
  // logged and the process exits, for the host's supervisor to restart it clean.
  process.on("unhandledRejection", (err) => log.error("unhandled rejection:", err));
  process.on("uncaughtException", (err) => {
    log.error("crashed:", err);
    try { store.close(); } catch { /* already closed */ }
    process.exit(1);
  });
  return { tick, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await startRunner(loadConfig(), { once: process.argv.includes("--once") });
    if (result === false) process.exit(1);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
}
