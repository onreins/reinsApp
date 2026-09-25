/**
 * Collect the trade history of the Arc mainnet USDC/EURC Uniswap v4 pool.
 *
 *   node research/collect-pool-history.js --blocks 172800
 *
 * Read-only. Appends to research/data/eurc-mainnet.ndjson and resumes from
 * wherever it stopped, so it can be run repeatedly to extend the window.
 *
 * Two Arc quirks shape this:
 *  - the public RPC ignores topic filters, so every PoolManager log comes back
 *    and we filter locally;
 *  - it caps a query at 2000 results, and the PoolManager emits roughly two
 *    logs per block across all pools, so windows stay small.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, toHex, encodeAbiParameters, decodeAbiParameters } from "viem";
import { arc } from "viem/chains";

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const NO_HOOKS = "0x0000000000000000000000000000000000000000";
const FEE = 500;
const TICK_SPACING = 10;

const OUT_DIR = "research/data";
const OUT = `${OUT_DIR}/eurc-mainnet.ndjson`;

const SWAP_TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const SWAP_ARGS = [
  { type: "int128" }, // amount0, from the pool's point of view
  { type: "int128" }, // amount1
  { type: "uint160" }, // sqrtPriceX96 after the swap
  { type: "uint128" }, // liquidity
  { type: "int24" }, // tick
  { type: "uint24" }, // fee
];

export const POOL_ID = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [USDC, EURC, FEE, TICK_SPACING, NO_HOOKS],
  ),
);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

/** The last block already collected, so a second run extends rather than repeats. */
function resumeFrom() {
  if (!existsSync(OUT)) return null;
  const lines = readFileSync(OUT, "utf8").trimEnd().split("\n").filter(Boolean);
  if (!lines.length) return null;
  return BigInt(JSON.parse(lines.at(-1)).block);
}

async function main() {
  const blocks = BigInt(arg("blocks", 172_800)); // ~24h at Arc's half-second blocks
  const window = BigInt(arg("window", 700));

  const client = createPublicClient({ chain: arc, transport: http() });
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const resume = resumeFrom();
  const from = resume === null ? head - blocks : resume + 1n;

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n  pool      ${POOL_ID}`);
  console.log(`  head      ${head}`);
  console.log(`  from      ${from}${resume === null ? "" : "  (resuming)"}`);
  console.log(`  windows   ${Number((head - from) / window) + 1} of ${window} blocks\n`);

  let collected = 0;
  let scanned = 0;
  let failures = 0;
  const started = Date.now();

  for (let b = from; b <= head; b += window) {
    const to = b + window - 1n > head ? head : b + window - 1n;
    let logs;
    try {
      logs = await client.getLogs({ address: POOL_MANAGER, fromBlock: b, toBlock: to });
    } catch (err) {
      failures += 1;
      if (failures > 60) throw new Error(`giving up after ${failures} failed windows: ${err.shortMessage ?? err.message}`);
      await new Promise((r) => setTimeout(r, 1500)); // most failures here are rate limits
      b -= window; // retry the same window
      continue;
    }
    scanned += 1;

    const rows = logs
      .filter((l) => l.topics[0] === SWAP_TOPIC && l.topics[1] === POOL_ID)
      .map((l) => {
        const [amount0, amount1, sqrtPriceX96, liquidity, tick] = decodeAbiParameters(SWAP_ARGS, l.data);
        return JSON.stringify({
          block: Number(l.blockNumber),
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          sqrtPriceX96: sqrtPriceX96.toString(),
          liquidity: liquidity.toString(),
          tick,
        });
      });

    if (rows.length) {
      appendFileSync(OUT, `${rows.join("\n")}\n`);
      collected += rows.length;
    }
    if (scanned % 25 === 0) {
      const done = Number(to - from);
      const total = Number(head - from);
      console.log(
        `  ${((done / total) * 100).toFixed(1).padStart(5)}%  block ${to}  ` +
          `${collected} swaps  ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
    }
  }

  console.log(`\n  collected ${collected} swaps into ${OUT} (${failures} windows retried)\n`);
}

main().catch((err) => {
  console.error("\n  collection failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
