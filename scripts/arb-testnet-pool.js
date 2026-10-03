/**
 * Move the testnet USDC/EURC pool back to the oracle price.
 *
 *   npm run arb:testnet
 *
 * On mainnet arbitrageurs close any gap between the pool and the market in
 * seconds. On testnet the only participants are us, so every time the price
 * feed is republished (scripts/publish-feed.js) the pool falls behind it, and an
 * agent's price band then refuses honest trades. This does the arbitrageur's
 * job with one swap from the deployer: EURC in when EURC is too dear in the
 * pool, USDC in when it's too cheap. The pool's tokens are USDC (token0) and
 * EURC (token1), both 6 decimals, so prices are EURC per USDC.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { ARC_TESTNET, OUT } from "./deploy-testnet.js";

const VENUE = artifact("UniswapV4Venue");
const FEED = artifact("PinnedFeed");
const ERC20 = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }];
const STATE_ABI = [{
  type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }],
  outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
}];
const Q96 = 2 ** 96;
export const TOLERANCE_BPS = 10;

/** How far the pool is from the oracle, and the one swap that closes the gap. */
export function swapToTarget({ spot, target, liquidity }) {
  const gapBps = ((spot - target) / target) * 10_000;
  if (Math.abs(gapBps) <= TOLERANCE_BPS) return { gapBps, swap: null };
  // Adding token1 (EURC) raises sqrt(P) by amount / L; adding token0 (USDC) lowers it.
  if (target > spot) return { gapBps, swap: { sell: "EURC", amount: BigInt(Math.round(liquidity * (Math.sqrt(target) - Math.sqrt(spot)))) } };
  return { gapBps, swap: { sell: "USDC", amount: BigInt(Math.round(liquidity * (1 / Math.sqrt(target) - 1 / Math.sqrt(spot)))) } };
}

export async function arbitrage({ publicClient, wallet, deployment }) {
  const { usdc, eurc, stateView } = ARC_TESTNET;
  const { uniswapV4Venue, pinnedFeed } = deployment.contracts;
  const [sqrtPriceX96] = await publicClient.readContract({ address: stateView, abi: STATE_ABI, functionName: "getSlot0", args: [deployment.pool.poolId] });
  const [, answer] = await publicClient.readContract({ address: pinnedFeed, abi: FEED.abi, functionName: "latestRoundData" });
  const spot = (Number(sqrtPriceX96) / Q96) ** 2;
  const target = 1 / (Number(answer) / 1e8);
  const { gapBps, swap } = swapToTarget({ spot, target, liquidity: Number(deployment.pool.liquidity) });
  if (!swap || swap.amount <= 0n) return { gapBps, hash: null };

  const [from, to] = swap.sell === "EURC" ? [eurc, usdc] : [usdc, eurc];
  const send = async (request) => {
    const hash = await wallet.writeContract({ ...request, account: wallet.account, chain: arcTestnet });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${request.functionName} reverted: ${hash}`);
    return hash;
  };
  await send({ address: from, abi: ERC20, functionName: "approve", args: [uniswapV4Venue, swap.amount] });
  const hash = await send({ address: uniswapV4Venue, abi: VENUE.abi, functionName: "swap", args: [from, to, swap.amount, 0n, wallet.account.address] });
  return { gapBps, sold: `${formatUnits(swap.amount, 6)} ${swap.sell}`, hash };
}

async function main() {
  const key = process.env.RATCHET_DEPLOYER_KEY;
  if (!key) throw new Error("RATCHET_DEPLOYER_KEY missing from .env");
  const deployment = JSON.parse(readFileSync(OUT, "utf8"));
  const transport = () => http(undefined, { retryCount: 6, retryDelay: 1500 });
  const publicClient = createPublicClient({ chain: arcTestnet, transport: transport() });
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: arcTestnet, transport: transport() });
  const r = await arbitrage({ publicClient, wallet, deployment });
  console.log(r.hash
    ? `\n  pool was ${r.gapBps.toFixed(0)} bps off the oracle; sold ${r.sold}\n  ${r.hash}\n`
    : `\n  pool is within ${TOLERANCE_BPS} bps of the oracle (${r.gapBps.toFixed(0)} bps); nothing to do\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\n  arbitrage failed:", err.shortMessage ?? err.message);
    process.exit(1);
  });
}
