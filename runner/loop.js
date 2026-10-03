/**
 * One pass over every hosted agent, in two halves so gas can be topped up
 * between them (a key bound this pass has no gas yet):
 *
 *   bind()  a trading key we issued, now used by a new agent, starts running,
 *           but only if that agent is one Reins runs: our base token, our
 *           exchange, exactly our asset and price feed, and (when the key was
 *           issued for an owner) that owner. Anything else uses the key against
 *           us, so the key is wiped and never runs.
 *   run()   for each running agent: settle any earlier trade whose outcome is
 *           unknown (or pause the agent for a person to look), read its status,
 *           pause it if its trading key is no longer ours, otherwise ask its
 *           strategy, write the decision as pending, and hand trades to the
 *           bridge's executor, which applies the risk engine and leaves the
 *           contract the last word.
 *
 * Nothing is ever resent: a decision id that has a row is never started again,
 * and a send that may have gone out (a timeout, a dropped connection) pauses
 * the agent rather than retrying. The kill switch is checked at the start and
 * again right before every send. One agent failing, or hanging, is recorded and
 * the pass carries on.
 */
import { MandateClient } from "../mandate/sdk.js";
import { createExecutor } from "../bridge/executor.js";
import { createRegistry } from "../bridge/registry.js";
import { createRiskEngine } from "../bridge/risk.js";
import { artifact } from "../scripts/artifact.js";
import { decide, signalFor } from "./brains/index.js";

const MANDATE = artifact("Mandate");
const ZERO = "0x0000000000000000000000000000000000000000";
export const UNBOUND_MAX_AGE_MS = 24 * 3_600_000;
export const HOLD_RETENTION_MS = 7 * 24 * 3_600_000;
export const AGENT_TIMEOUT_MS = 60_000;
// After a refused, held-back or failed trade, wait this long before trying again:
// a pool off the oracle or a stale price doesn't fix itself in five minutes.
export const BACKOFF_MS = 3_600_000;
const BACKOFF_OUTCOMES = new Set(["refused", "risk", "error", "skipped"]);

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const brief = (err) => String(err?.shortMessage ?? err?.message ?? err).split("\n")[0].slice(0, 200);
const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} p
 * @param {ReturnType<import("./store.js").openStore>} p.store
 * @param {ReturnType<import("./keystore.js").createKeystore>} p.keystore
 * @param {import("viem").PublicClient} p.publicClient
 * @param {(account: any) => import("viem").WalletClient} p.walletFor
 * @param {() => Promise<Array<{ address: string, owner: string, agent: string }>>} p.discover  every agent the factory created
 * @param {{ base: string, venue: string, assets: Record<string, string> }} p.expected  what an agent we run must be built from (asset token → its price feed)
 * @param {number} p.tickMs
 * @param {() => boolean} p.killSwitch
 * @param {(p: { client: MandateClient, ledger: any }) => { handle(signal: any): Promise<any> }} [p.executorFor]
 */
export function createLoop({ store, keystore, publicClient, walletFor, discover, expected, tickMs, killSwitch, executorFor, now = () => Date.now(), log = null, agentTimeoutMs = AGENT_TIMEOUT_MS }) {
  if (!expected?.base || !expected?.venue || !expected?.assets) throw new Error("the loop needs the deployment's base, venue and assets to check agents against");
  const registry = createRegistry({ map: { EURC: "EURC" } });
  const risk = createRiskEngine();
  const makeExecutor = executorFor ?? (({ client, ledger }) => createExecutor({ client, registry, ledger, mode: "live", risk }));
  const accounts = new Map(); // address → viem account, opened once per process

  const read = (address, functionName, args = []) => publicClient.readContract({ address, abi: MANDATE.abi, functionName, args });

  /** Why this agent isn't one Reins runs, or null if it is. */
  async function mismatch(mandate, key) {
    const [base, venue, assets] = await Promise.all([read(mandate.address, "base"), read(mandate.address, "venue"), read(mandate.address, "assetList")]);
    if (!same(base, expected.base)) return "its base token isn't the deployment's USDC";
    if (!same(venue, expected.venue)) return "its exchange isn't the deployment's venue";
    const want = Object.entries(expected.assets);
    if (assets.length !== want.length) return "it holds assets Reins doesn't trade";
    for (const token of assets) {
      const feed = want.find(([t]) => same(t, token))?.[1];
      if (!feed) return "it holds assets Reins doesn't trade";
      const [actual] = await read(mandate.address, "assets", [token]);
      if (!same(actual, feed)) return "its price feed isn't the deployment's";
    }
    if (key.owner && !same(mandate.owner, key.owner)) return "its owner isn't the one the key was issued to";
    return null;
  }

  async function bind() {
    const summary = { bound: 0, rejected: 0 };
    store.purgeUnbound(now(), UNBOUND_MAX_AGE_MS);
    const waiting = store.keys({ unbound: true });
    if (!waiting.length) return summary;
    for (const m of await discover()) {
      const k = waiting.find((w) => same(w.address, m.agent));
      if (!k) continue;
      const why = await mismatch(m, k).catch((err) => `it couldn't be checked (${brief(err)})`);
      if (why) {
        store.pause(k.address, `Not run: ${why}. The key is wiped.`, now(), { forget: true });
        summary.rejected += 1;
        log?.warn(`key ${k.address} rejected for agent ${m.address}: ${why}`);
      } else if (store.bind(k.address, m.address, now())) {
        summary.bound += 1;
      }
    }
    return summary;
  }

  /** An earlier trade whose outcome we don't know: confirm it from its receipt, or stop for a person. */
  async function resolveEarlier(k) {
    const open = store.unresolved(k.mandate);
    if (!open) return true;
    if (open.txHash) {
      const receipt = await publicClient.getTransactionReceipt({ hash: open.txHash }).catch(() => null);
      if (receipt?.status === "success") { store.settle(open.id, "traded", `${open.reason ?? "Trade"} (confirmed on a later pass)`); return true; }
      if (receipt?.status === "reverted") { store.settle(open.id, "refused", "The transaction reverted on-chain"); return true; }
    }
    store.pause(k.address, "An earlier trade's outcome is unknown. Check the agent's transactions on the explorer before resuming it.", now());
    return false;
  }

  function accountFor(k) {
    if (!accounts.has(k.address)) accounts.set(k.address, keystore.account(k.sealed, k.address));
    return accounts.get(k.address);
  }

  async function runOne(k) {
    if (!(await resolveEarlier(k))) return "paused";
    const client = new MandateClient({ publicClient, wallet: walletFor(accountFor(k)), address: k.mandate });
    const status = await client.status();
    if (!same(status.agent, k.address)) {
      // The owner took the key away; it will never be used again, so wipe it.
      store.pause(k.address, same(status.agent, ZERO) ? "The owner revoked the trading key" : "The owner set a different trading key", now(), { forget: true });
      accounts.delete(k.address);
      return "paused";
    }

    const last = store.lastAct(k.mandate);
    const decision = last && BACKOFF_OUTCOMES.has(last.outcome) && now() - last.at < BACKOFF_MS
      ? { side: "hold", reason: `Held: its last trade was ${last.outcome === "risk" ? "held back by the risk engine" : last.outcome === "refused" ? "refused" : last.outcome === "skipped" ? "skipped" : "not completed"}${last.rule ? ` (${last.rule})` : ""}; trying again within the hour` }
      : decide(k.strategy, status, k.settings, { now: now(), lastTradeAt: store.lastTradeAt(k.mandate) });
    const signal = signalFor({ strategy: k.strategy, mandate: k.mandate, now: now(), tickMs, decision });
    if (store.decision(signal.id)) return "skipped"; // this pass already decided

    if (signal.side === "hold") {
      // The same hold as last time is one row that repeats, not a new row every pass.
      const prev = store.latest(k.mandate);
      if (prev?.outcome === "hold" && prev.reason === signal.reason) {
        // Counted once per pass: a pass run twice doesn't count twice.
        if (Math.floor(prev.at / tickMs) !== Math.floor(now() / tickMs)) store.repeatHold(prev.id, now());
        return "held";
      }
      store.begin(signal.id, { mandate: k.mandate, strategy: k.strategy, signal, at: now() });
      store.ledger().append({ signal, outcome: "hold", reason: signal.reason });
      return "held";
    }
    store.begin(signal.id, { mandate: k.mandate, strategy: k.strategy, signal, at: now() });
    if (killSwitch()) {
      store.settle(signal.id, "skipped", "The kill switch is on: nothing was sent");
      return "skipped";
    }
    try {
      const record = await makeExecutor({ client, ledger: store.ledger() }).handle(signal);
      return record?.outcome === "traded" ? "traded" : "other";
    } catch (err) {
      if (err?.maybeSent) {
        store.settle(signal.id, "unknown", `The send may have gone out: ${brief(err)}. It will not be resent.`);
        store.pause(k.address, "A trade may have been sent without confirmation. Check the agent's transactions on the explorer before resuming it.", now());
        return "paused";
      }
      store.settle(signal.id, "error", `Couldn't finish: ${brief(err)}`);
      throw err;
    }
  }

  async function run() {
    const summary = { traded: 0, held: 0, paused: 0, skipped: 0, other: 0, errors: 0 };
    store.pruneHolds(now() - HOLD_RETENTION_MS);
    for (const k of store.keys({ running: true })) {
      if (killSwitch()) break;
      try {
        if (!k.settings) throw new Error("its stored settings can't be read");
        summary[await withTimeout(runOne(k), agentTimeoutMs, `agent ${k.mandate}`)] += 1;
      } catch (err) {
        summary.errors += 1;
        log?.error(`agent ${k.mandate}: ${brief(err)}`);
      }
    }
    return summary;
  }

  return {
    bind,
    run,
    /** bind() then run(), for tests and callers without a gas step in between. */
    async pass() {
      if (killSwitch()) return { killSwitch: true, bound: 0, rejected: 0, traded: 0, held: 0, paused: 0, skipped: 0, other: 0, errors: 0 };
      return { ...(await bind()), ...(await run()) };
    },
  };
}
