/**
 * Prove a Mandate trades correctly on Arc mainnet, without spending anything.
 *
 *   node scripts/sim-mainnet.js [tradeSizeUsd]
 *
 * One `eth_call` against live Arc mainnet state. The MandateSim harness's code
 * is injected at a spare address and given a USDC balance (both only inside
 * this call). It then deploys a real UniswapV4Venue and Mandate, funds the
 * mandate, and has an agent trade USDC → EURC → USDC through the real Uniswap
 * v4 pool, checked against the real Chainlink EURC/USD feed. Nothing is
 * broadcast, so no keys and no money are needed.
 */
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseEther } from "viem";
import { arc } from "viem/chains";

import { artifact } from "./artifact.js";

const MAINNET = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  eurcUsdFeed: "0x361b95c10b76Ca3f35C686d423e43A951755Bf23",
  fee: 500,
  tickSpacing: 10,
};
const HARNESS = "0x000000000000000000000000000000000000b0b5";

const tradeUsd = Number(process.argv[2] ?? 10);
const tradeSize = BigInt(Math.round(tradeUsd * 1e6));
const sim = artifact("MandateSim");
const client = createPublicClient({ chain: arc, transport: http() });

const setup = {
  poolManager: MAINNET.poolManager,
  usdc: MAINNET.usdc,
  foreign: MAINNET.eurc,
  foreignFeed: MAINNET.eurcUsdFeed,
  fee: MAINNET.fee,
  tickSpacing: MAINNET.tickSpacing,
  tradeSize,
};
const data = encodeFunctionData({ abi: sim.abi, functionName: "run", args: [setup] });

const fmt = (units, dp = 6) => (Number(units) / 10 ** dp).toFixed(4);

try {
  const { data: raw } = await client.call({
    to: HARNESS,
    data,
    gas: 30_000_000n,
    // Native USDC has 18 decimals; this gives the harness $1,000 inside the call only.
    stateOverride: [{ address: HARNESS, code: sim.deployedBytecode, balance: parseEther("1000") }],
  });
  const r = decodeFunctionResult({ abi: sim.abi, functionName: "run", data: raw });
  const oracle = Number(r.oraclePrice) / 1e8;
  const eurcOut = Number(r.foreignOut) / 1e6;
  const fillPrice = tradeUsd / eurcOut;

  console.log(`\n  Mandate × Uniswap v4 on Arc mainnet (simulated, nothing broadcast)\n`);
  console.log(`  deposited            $${fmt(r.deposited)}`);
  console.log(`  Chainlink EURC/USD   $${oracle.toFixed(4)}`);
  console.log(
    `  bought               ${eurcOut.toFixed(4)} EURC for $${tradeUsd.toFixed(2)}  ` +
      `(fill $${fillPrice.toFixed(4)} per EURC, ${(((fillPrice - oracle) / oracle) * 100).toFixed(3)}% vs oracle)`,
  );
  console.log(`  equity after buy     $${fmt(r.equityAfterFirst)}`);
  console.log(`  sold back for        $${fmt(r.baseBack)}`);
  console.log(`  equity at the end    $${fmt(r.equityEnd)}  (round trip cost $${fmt(r.deposited - r.equityEnd)})\n`);
} catch (err) {
  console.error("\n  simulation failed:", err.shortMessage ?? err.message);
  if (err.cause?.data) console.error("  revert data:", err.cause.data);
  await diagnose();
  process.exit(1);
}

/**
 * A revert inside one big eth_call often arrives with no message. Rerun the
 * same path stage by stage (MandateSim.diagnose) and say which one failed.
 */
async function diagnose() {
  const STAGES = ["none", "deploy venue", "set route", "deploy agent", "deploy mandate", "approve USDC", "deposit", "read Chainlink feed", "buy EURC", "sell EURC back"];
  try {
    const { data: raw } = await client.call({
      to: HARNESS,
      data: encodeFunctionData({ abi: sim.abi, functionName: "diagnose", args: [setup] }),
      gas: 30_000_000n,
      stateOverride: [{ address: HARNESS, code: sim.deployedBytecode, balance: parseEther("1000") }],
    });
    const [stage, reason] = decodeFunctionResult({ abi: sim.abi, functionName: "diagnose", data: raw });
    if (stage === 0) {
      console.error("  diagnosis: every stage passed when run one at a time; the failure was transient or specific to run()");
    } else {
      console.error(`  diagnosis: stage ${stage} (${STAGES[stage]}) failed, revert data ${reason === "0x" ? "empty" : reason}`);
    }
  } catch (e) {
    console.error("  diagnosis could not run either:", e.shortMessage ?? e.message);
  }
}
