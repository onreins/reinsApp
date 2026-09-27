/**
 * Where every signal's outcome is written: traded, refused, skipped, or
 * shadow. The shadow records are the point for now: they are a strategy's
 * paper track record on assets that aren't on Arc yet, kept apart from real
 * trades by their outcome.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** For tests and short runs: records kept in memory. */
export function memoryLedger() {
  const rows = [];
  return {
    append: (record) => rows.push(record),
    all: () => rows.slice(),
    has: (id) => rows.some((r) => r.signal?.id === id && r.outcome !== "duplicate"),
  };
}

/** One JSON object per line, appended; survives restarts. */
export function fileLedger(path) {
  mkdirSync(dirname(path), { recursive: true });
  // A line cut short by a crash is skipped, not fatal: one bad line must not
  // stop the bridge from starting or hide every other record.
  const read = () => {
    if (!existsSync(path)) return [];
    const rows = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        console.warn(`bridge: skipped an unreadable ledger line in ${path}`);
      }
    }
    return rows;
  };
  const seen = new Set(read().filter((r) => r.outcome !== "duplicate").map((r) => r.signal?.id));
  return {
    append(record) {
      appendFileSync(path, JSON.stringify(record) + "\n");
      if (record.outcome !== "duplicate") seen.add(record.signal?.id);
    },
    all: read,
    has: (id) => seen.has(id),
  };
}
