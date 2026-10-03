/**
 * The runner's memory, in SQLite (Node's built-in driver, Node 22.13 or later).
 *
 *   hosted_agents  one row per trading key: its sealed key, the strategy and owner
 *                  it was issued for, and the agent it runs once one uses it
 *   decisions      one row per decision, written as "pending" before anything is
 *                  sent, and finished with the executor's outcome
 *   gas_spend      every gas top-up, so the daily caps survive a restart
 *
 * ledger() adapts decisions to the executor's ledger interface. A pending row
 * doesn't count as handled (the executor is about to handle it), but the loop
 * never starts a decision whose id already has a row, and at startup any row
 * still pending becomes "unknown": a crash between sending and recording never
 * leads to a resend.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BUSY_MS = 5000;
const MAX_LIMIT = 500;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS hosted_agents (
    address      TEXT PRIMARY KEY COLLATE NOCASE,
    enc          TEXT NOT NULL,
    iv           TEXT NOT NULL,
    tag          TEXT NOT NULL,
    strategy     TEXT NOT NULL,
    settings     TEXT NOT NULL,
    owner        TEXT COLLATE NOCASE,
    mandate      TEXT COLLATE NOCASE,
    issued_at    INTEGER NOT NULL,
    bound_at     INTEGER,
    paused_at    INTEGER,
    pause_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS decisions (
    id        TEXT PRIMARY KEY,
    mandate   TEXT NOT NULL COLLATE NOCASE,
    strategy  TEXT NOT NULL,
    at        INTEGER NOT NULL,
    outcome   TEXT NOT NULL,
    side      TEXT,
    asset     TEXT,
    size_usd  REAL,
    fraction  REAL,
    rule      TEXT,
    reason    TEXT,
    tx_hash   TEXT,
    record    TEXT
  );
  CREATE INDEX IF NOT EXISTS decisions_by_agent ON decisions (mandate, at);
  CREATE TABLE IF NOT EXISTS gas_spend (
    day      TEXT NOT NULL,
    address  TEXT NOT NULL COLLATE NOCASE,
    wei      TEXT NOT NULL,
    hash     TEXT,
    at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gas_by_day ON gas_spend (day, address);
`;

// A row that can't be read is reported, not fatal: one bad row must not stop every agent.
const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const keyRow = (r) => r && {
  address: r.address,
  sealed: { enc: r.enc, iv: r.iv, tag: r.tag },
  strategy: r.strategy,
  settings: parse(r.settings),
  owner: r.owner ?? null,
  mandate: r.mandate ?? null,
  issuedAt: r.issued_at,
  boundAt: r.bound_at ?? null,
  pausedAt: r.paused_at ?? null,
  pauseReason: r.pause_reason ?? null,
};

const decisionRow = (r) => r && {
  id: r.id,
  mandate: r.mandate,
  strategy: r.strategy,
  at: r.at,
  outcome: r.outcome,
  side: r.side,
  asset: r.asset,
  sizeUsd: r.size_usd,
  fraction: r.fraction,
  rule: r.rule,
  reason: r.reason,
  txHash: r.tx_hash,
  repeats: r.repeats ?? 1,
};

/** @param {string} path  a file, or ":memory:" for tests */
export function openStore(path) {
  const onDisk = path !== ":memory:";
  if (onDisk) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // Added after the first databases existed: an identical hold repeats one row instead of adding one per pass.
  const columns = db.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
  if (!columns.includes("repeats")) db.exec("ALTER TABLE decisions ADD COLUMN repeats INTEGER NOT NULL DEFAULT 1");
  // The database holds sealed keys: readable by this user only.
  if (onDisk) for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) try { chmodSync(f, 0o600); } catch { /* not on every filesystem */ }
  const q = (sql) => db.prepare(sql);
  const getDecision = q("SELECT * FROM decisions WHERE id = ?");

  return {
    issueKey({ address, sealed, strategy, settings, owner = null, at }) {
      q("INSERT INTO hosted_agents (address, enc, iv, tag, strategy, settings, owner, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(address, sealed.enc, sealed.iv, sealed.tag, strategy, JSON.stringify(settings), owner, at);
    },
    key: (address) => keyRow(q("SELECT * FROM hosted_agents WHERE address = ?").get(address)) ?? null,
    /** running: bound to an agent and not paused. unbound: waiting for an agent to use it (and not paused). */
    keys({ running = false, unbound = false } = {}) {
      const where = running ? "WHERE mandate IS NOT NULL AND paused_at IS NULL" : unbound ? "WHERE mandate IS NULL AND paused_at IS NULL" : "";
      return q(`SELECT * FROM hosted_agents ${where} ORDER BY issued_at`).all().map(keyRow);
    },
    countRunning: () => Number(q("SELECT COUNT(*) AS n FROM hosted_agents WHERE mandate IS NOT NULL AND paused_at IS NULL").get().n),
    /** @returns {boolean} whether it bound (false if the key was already bound) */
    bind(address, mandate, at) {
      return Number(q("UPDATE hosted_agents SET mandate = ?, bound_at = ? WHERE address = ? AND mandate IS NULL").run(mandate, at, address).changes) > 0;
    },
    /** Stop running a key. With forget, its sealed key is wiped too: it will never sign again. */
    pause(address, reason, at, { forget = false } = {}) {
      if (forget) q("UPDATE hosted_agents SET paused_at = ?, pause_reason = ?, enc = '', iv = '', tag = '' WHERE address = ?").run(at, reason, address);
      else q("UPDATE hosted_agents SET paused_at = ?, pause_reason = ? WHERE address = ?").run(at, reason, address);
    },
    /** Forget keys no agent used within maxAgeMs. Returns how many. */
    purgeUnbound(now, maxAgeMs) {
      return Number(q("DELETE FROM hosted_agents WHERE mandate IS NULL AND issued_at < ?").run(now - maxAgeMs).changes);
    },

    decision: (id) => decisionRow(getDecision.get(id)) ?? null,
    /** Record a decision before acting on it. Throws if the id already has a row. */
    begin(id, { mandate, strategy, signal, at }) {
      q("INSERT INTO decisions (id, mandate, strategy, at, outcome, side, asset, size_usd, fraction, reason) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)")
        .run(id, mandate, strategy, at, signal.side ?? null, signal.asset ?? null, signal.sizeUsd ?? null, signal.fraction ?? null, signal.reason ?? null);
    },
    /** Set a decision's outcome directly (an error, an interrupted send, a later confirmation). */
    settle(id, outcome, reason, txHash = undefined) {
      if (txHash === undefined) q("UPDATE decisions SET outcome = ?, reason = ? WHERE id = ?").run(outcome, reason, id);
      else q("UPDATE decisions SET outcome = ?, reason = ?, tx_hash = ? WHERE id = ?").run(outcome, reason, txHash, id);
    },
    /** At startup: anything still pending was cut off mid-pass. Returns how many. */
    settleStale(reason) {
      return Number(q("UPDATE decisions SET outcome = 'unknown', reason = ? WHERE outcome = 'pending'").run(reason).changes);
    },
    /** The newest decision, any kind. */
    latest: (mandate) => decisionRow(q("SELECT * FROM decisions WHERE mandate = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(mandate)) ?? null,
    /** The newest buy or sell, whatever came of it. */
    lastAct: (mandate) => decisionRow(q("SELECT * FROM decisions WHERE mandate = ? AND side IN ('buy', 'sell') ORDER BY at DESC, rowid DESC LIMIT 1").get(mandate)) ?? null,
    /** When this agent last actually traded, or null. A trade a person confirmed went through counts. */
    lastTradeAt: (mandate) => q("SELECT MAX(at) AS at FROM decisions WHERE mandate = ? AND outcome IN ('traded', 'reviewed-sent')").get(mandate)?.at ?? null,
    /** The same hold again: move it to now and count it, instead of adding a row. */
    repeatHold(id, at) {
      q("UPDATE decisions SET at = ?, repeats = repeats + 1 WHERE id = ?").run(at, id);
    },
    /**
     * After a person has checked a paused agent's unknown trades on the explorer:
     * record what they found (sent, or not sent) with their note, and run the
     * key again, in one transaction. Throws, changing nothing, if the key isn't
     * paused or was wiped. Returns how many trades were marked.
     */
    resumeReviewed(address, { sent, note }) {
      const k = keyRow(q("SELECT * FROM hosted_agents WHERE address = ?").get(address));
      if (!k) throw new Error(`no hosted key ${address}`);
      if (k.sealed.enc === "") throw new Error("that key was wiped (revoked or rejected) and can't run again");
      if (!k.pausedAt) throw new Error("that key isn't paused");
      db.exec("BEGIN IMMEDIATE");
      try {
        const marked = k.mandate
          ? Number(q("UPDATE decisions SET outcome = ?, reason = COALESCE(reason, '') || ' (checked: ' || ? || ')' WHERE mandate = ? AND outcome IN ('pending', 'unknown')")
              .run(sent ? "reviewed-sent" : "reviewed-unsent", note, k.mandate).changes)
          : 0;
        q("UPDATE hosted_agents SET paused_at = NULL, pause_reason = NULL WHERE address = ?").run(address);
        db.exec("COMMIT");
        return marked;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    /** The agent's oldest trade whose outcome isn't known yet, if any. */
    unresolved: (mandate) =>
      decisionRow(q("SELECT * FROM decisions WHERE mandate = ? AND outcome IN ('pending', 'unknown') ORDER BY at, rowid LIMIT 1").get(mandate)) ?? null,
    decisions: (mandate, limit = 50) =>
      q("SELECT * FROM decisions WHERE mandate = ? ORDER BY at DESC, rowid DESC LIMIT ?")
        .all(mandate, Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || 50)))
        .map(decisionRow),
    /** Holds are kept for a while for the feed, then dropped; trades are kept for good. */
    pruneHolds(before) {
      return Number(q("DELETE FROM decisions WHERE outcome = 'hold' AND at < ?").run(before).changes);
    },

    /** Gas sent today, in wei: in total, or to one address. */
    gasSpent(day, address = null) {
      const rows = address
        ? q("SELECT wei FROM gas_spend WHERE day = ? AND address = ?").all(day, address)
        : q("SELECT wei FROM gas_spend WHERE day = ?").all(day);
      return rows.reduce((sum, r) => sum + BigInt(r.wei), 0n);
    },
    recordGas({ day, address, wei, hash, at }) {
      q("INSERT INTO gas_spend (day, address, wei, hash, at) VALUES (?, ?, ?, ?, ?)").run(day, address, wei.toString(), hash ?? null, at);
    },

    /** The executor's ledger interface over the decisions table. */
    ledger() {
      return {
        has(id) {
          const row = getDecision.get(id);
          return !!row && row.outcome !== "pending";
        },
        append(record) {
          const id = record.signal?.id;
          if (!id || record.outcome === "duplicate") return;
          const row = getDecision.get(id);
          if (!row) return; // the loop always begins a decision first; anything else isn't ours
          // A trade cut to the agent's per-trade cap says what was actually sent.
          const capped = record.outcome === "traded" && record.clamped && record.trade?.amount != null;
          const reason = capped ? `${row.reason}; sent ${record.trade.amount} ${record.trade.from}, its per-trade cap` : record.reason ?? row.reason;
          q("UPDATE decisions SET outcome = ?, rule = ?, reason = ?, tx_hash = ?, record = ? WHERE id = ?").run(
            record.outcome,
            record.rule ?? null,
            reason,
            record.hash ?? null,
            JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
            id,
          );
        },
      };
    },
    close: () => db.close(),
  };
}
