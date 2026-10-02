/**
 * Save the indexer's log reads so a fresh server doesn't rescan the chain.
 *
 *   npm run snapshot:index
 *
 * The app reads every agent from logs, paged 10k blocks at a time through
 * Arc's rate-limited public RPC. A long-lived server does that once; a
 * serverless one does it on every cold start, which is over a hundred requests
 * per agent and ends in rate-limit errors. Logs from past blocks never change,
 * so this writes everything up to the current head to
 * app/data/index-snapshot.json; the server seeds from it and reads only newer
 * blocks. Re-run it now and then (it resumes from the last snapshot) and
 * commit the file.
 *
 * APP_RPC picks a different RPC; APP_NETWORK a different deployment.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { arc, arcTestnet } from "viem/chains";

import { ArenaIndexer } from "../arena/indexer.js";
import { loadDeployment } from "../app/server.js";

const OUT = fileURLToPath(new URL("../app/data/index-snapshot.json", import.meta.url));
const ATTEMPTS = 30;
const BACKOFF_MS = 4_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Scans resume from the window that failed, so retrying a rate-limited one is cheap. */
async function patiently(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      process.stdout.write(`  ${label}: ${err.shortMessage ?? err.message}; retrying (${attempt})\n`);
      await sleep(BACKOFF_MS);
    }
  }
}

async function main() {
  const dep = loadDeployment(process.env.APP_NETWORK ?? "testnet");
  const chain = dep.chainId === arc.id ? arc : arcTestnet;
  const publicClient = createPublicClient({ chain, transport: http(process.env.APP_RPC, { retryCount: 3, retryDelay: 1_000 }) });
  const indexer = new ArenaIndexer({ publicClient, factory: dep.contracts.mandateFactory, fromBlock: BigInt(dep.fromBlock ?? 0) });

  if (existsSync(OUT)) {
    const seeded = indexer.seedLogs(JSON.parse(readFileSync(OUT, "utf8")));
    console.log(`\n  resuming from the last snapshot (${seeded} addresses)`);
  }

  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  console.log(`  reading to block ${head}`);
  const mandates = await patiently("factory", () => indexer.mandates({ toBlock: head }));
  for (const m of mandates) {
    await patiently(m.address, () => indexer._logs({ address: m.address, fromBlock: indexer.fromBlock, toBlock: head }));
    console.log(`  ${m.address}  ${m.name}`);
  }

  const saved = { network: dep.network, chainId: dep.chainId, toBlock: head.toString(), savedAt: new Date().toISOString(), ...indexer.exportLogs() };
  writeFileSync(OUT, JSON.stringify(saved) + "\n");
  console.log(`\n  ${mandates.length} agents, up to block ${head}, saved to app/data/index-snapshot.json\n`);
}

main().catch((err) => {
  console.error("\n  snapshot failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
