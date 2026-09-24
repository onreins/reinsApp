/**
 * Verdict as a running service.
 *
 *   node --env-file=.env evaluator/daemon.js
 *
 * Watches AgenticCommerce (and optionally an ERC-8004 ValidationRegistry) for
 * work addressed to this evaluator, judges it, and settles it on-chain. It
 * remembers the last block it finished so a restart resumes exactly where it
 * stopped: nothing is skipped, and nothing is settled twice (the evaluator also
 * re-reads each job's status before acting, so a crash between "decided" and
 * "recorded" cannot double-settle).
 *
 * Environment:
 *   RATCHET_EVALUATOR_KEY   the key holding the evaluator seat (required)
 *   RATCHET_NETWORK         testnet | mainnet            (default testnet)
 *   RATCHET_COMMERCE        AgenticCommerce address      (default: deployments/<net>.json)
 *   RATCHET_VALIDATION      ERC-8004 ValidationRegistry  (optional)
 *   RATCHET_FROM_BLOCK      first block to scan on a fresh start (default: current head)
 *   RATCHET_POLL_MS         poll interval                (default 5000)
 *   RATCHET_STATE_FILE      where progress is saved      (default .verdict-state.<net>.json)
 *   RATCHET_VERDICT_DIR     where sealed verdicts go     (default verdicts/)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { Evaluator } from "./index.js";

/**
 * Progress on disk. Written atomically (temp file + rename) so a crash mid-write
 * leaves the previous good state rather than a truncated file.
 */
export class StateFile {
  constructor(path) {
    this.path = path;
  }

  load() {
    if (!existsSync(this.path)) return null;
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    return { ...raw, lastBlock: BigInt(raw.lastBlock) };
  }

  save(state) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ ...state, lastBlock: state.lastBlock.toString() }, null, 2)}\n`,
    );
    renameSync(tmp, this.path);
  }
}

/**
 * One pass: judge everything submitted since the last pass, then record progress.
 *
 * Progress is saved only after the whole range has been handled, so a failure
 * part-way through re-scans that range next time instead of skipping it. Jobs
 * already settled are recognised from their on-chain status and skipped.
 */
export async function runOnce({ evaluator, publicClient, stateFile, fromBlock }) {
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const saved = stateFile.load();

  const start = saved ? saved.lastBlock + 1n : (fromBlock ?? head);
  if (start > head) return { from: start, to: head, results: [] };

  const results = await evaluator.scan({ fromBlock: start, toBlock: head });
  stateFile.save({ lastBlock: head, updatedAt: new Date().toISOString() });
  return { from: start, to: head, results };
}

/** Publisher that writes sealed verdicts to a directory, one file per verdict. */
export function directoryPublisher(dir) {
  mkdirSync(dir, { recursive: true });
  return async (sealed) => {
    const file = join(dir, `verdict-${sealed.hash}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ hash: sealed.hash, signature: sealed.signature, verdict: sealed.verdict }, null, 2)}\n`,
    );
    return file.replaceAll("\\", "/");
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const network = process.env.RATCHET_NETWORK ?? "testnet";
  const chain = network === "mainnet" ? arc : arcTestnet;

  const key = process.env.RATCHET_EVALUATOR_KEY;
  if (!key) {
    console.error("\n  RATCHET_EVALUATOR_KEY is not set. Run with --env-file=.env.\n");
    process.exit(1);
  }

  let commerce = process.env.RATCHET_COMMERCE;
  if (!commerce) {
    const file = `deployments/${network}.json`;
    if (!existsSync(file)) {
      console.error(`\n  No RATCHET_COMMERCE and no ${file}. Deploy first: npm run deploy:arc\n`);
      process.exit(1);
    }
    commerce = JSON.parse(readFileSync(file, "utf8")).contracts.agenticCommerce;
  }

  const pollMs = Number(process.env.RATCHET_POLL_MS ?? 5000);
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport: http() });
  const wallet = createWalletClient({ account, chain, transport: http() });

  const evaluator = new Evaluator({
    publicClient,
    wallet,
    jobs: commerce,
    validation: process.env.RATCHET_VALIDATION,
    publish: directoryPublisher(process.env.RATCHET_VERDICT_DIR ?? "verdicts"),
  });

  const stateFile = new StateFile(process.env.RATCHET_STATE_FILE ?? `.verdict-state.${network}.json`);
  const fromBlock = process.env.RATCHET_FROM_BLOCK ? BigInt(process.env.RATCHET_FROM_BLOCK) : undefined;

  console.log(`\n  Verdict evaluator — ${chain.name}`);
  console.log(`  seat       ${account.address}`);
  console.log(`  watching   ${commerce}`);
  console.log(`  state      ${stateFile.path}`);
  console.log(`  polling    every ${pollMs}ms\n`);

  let stopping = false;
  const stop = (sig) => {
    console.log(`\n  ${sig} — finishing the current pass, then stopping.`);
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    try {
      const { results } = await runOnce({ evaluator, publicClient, stateFile, fromBlock });
      for (const r of results) {
        if (r.skipped) continue;
        const id =
          r.jobId !== undefined ? `job #${r.jobId}` : `validation ${String(r.requestHash).slice(0, 12)}…`;
        console.log(
          `  ${new Date().toISOString()}  ${id}  ${String(r.outcome).toUpperCase()}` +
            `${r.verdict?.reason ? ` — ${r.verdict.reason}` : ""}${r.txHash ? `  tx ${r.txHash}` : ""}`,
        );
      }
    } catch (err) {
      // A failed pass is retried from the same saved block next time round.
      console.error(`  pass failed, will retry: ${err.shortMessage ?? err.message}`);
    }
    if (!stopping) await new Promise((r) => setTimeout(r, pollMs));
  }
  console.log("  stopped cleanly.\n");
}

// Run only when executed directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error("\n  evaluator daemon failed:", err.shortMessage ?? err.message);
    process.exit(1);
  });
}
