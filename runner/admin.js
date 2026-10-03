/**
 * Looking after hosted agents by hand.
 *
 *   npm run runner:admin -- status
 *       every hosted key: its agent, strategy, state, and latest decision
 *   npm run runner:admin -- resume <key or agent address> --sent|--not-sent "what you checked"
 *       after an agent paused itself (a trade it couldn't confirm), and you've
 *       looked at its transactions on the explorer: say whether the trade went
 *       through (--sent counts it, so a savings agent doesn't buy again too soon)
 *       or not (--not-sent), add a note, and it runs again. A wiped key (revoked
 *       by its owner, or rejected) can't be resumed. Nothing changes on error.
 */
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function run(argv, { config = loadConfig(), out = console.log } = {}) {
  const [command, target, ...rest] = argv;
  const verdict = rest.find((a) => a === "--sent" || a === "--not-sent");
  const note = rest.filter((a) => a !== "--sent" && a !== "--not-sent");
  const store = openStore(config.dbPath);
  try {
    if (command === "status") {
      const keys = store.keys();
      if (!keys.length) return out("\n  no hosted keys yet\n");
      for (const k of keys) {
        const state = k.pausedAt ? `paused: ${k.pauseReason}` : k.mandate ? "running" : "waiting for an agent to use it";
        const last = k.mandate ? store.latest(k.mandate) : null;
        out(`\n  ${k.address}  ${k.strategy}  ${JSON.stringify(k.settings)}`);
        out(`    agent   ${k.mandate ?? "none yet"}${k.owner ? `   owner ${k.owner}` : ""}`);
        out(`    state   ${state}`);
        if (last) out(`    latest  ${last.outcome}, ${ago(last.at)}${last.repeats > 1 ? ` (x${last.repeats})` : ""}: ${last.reason ?? ""}`);
      }
      return out("");
    }
    if (command === "resume") {
      if (!target) throw new Error("say which key or agent to resume");
      if (!verdict) throw new Error("say whether the trade you checked went through: --sent or --not-sent");
      if (!note.join(" ").trim()) throw new Error("add a note saying what you checked, e.g. \"tx 0xabc… confirmed on the explorer\"");
      const k = store.keys().find((x) => [x.address, x.mandate].some((a) => a && a.toLowerCase() === target.toLowerCase()));
      if (!k) throw new Error(`no hosted key or agent ${target}`);
      const marked = store.resumeReviewed(k.address, { sent: verdict === "--sent", note: note.join(" ") });
      return out(`\n  resumed ${k.address}${marked ? `; ${marked} trade(s) marked as checked (${verdict === "--sent" ? "sent" : "not sent"})` : ""}\n`);
    }
    throw new Error("commands: status, resume <address> --sent|--not-sent \"note\"");
  } finally {
    store.close();
  }
}
