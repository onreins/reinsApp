/**
 * Refresh the testnet price feed from the real one.
 *
 *   npm run feed:publish
 *
 * PinnedFeed carries the mainnet Chainlink EURC/USD answer, and mandates
 * refuse to trade or value themselves on a price older than their limit.
 * Chainlink only updates on a 0.5% move, so after a quiet day the copy goes
 * stale and every equity figure honestly reads "—" until someone pushes a
 * fresh answer. This is that push: one read from mainnet, one testnet
 * transaction from the feed's publisher key.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { mainnetEurcUsd, OUT } from "./deploy-testnet.js";

const FEED = artifact("PinnedFeed");

async function main() {
  const key = process.env.RATCHET_DEPLOYER_KEY;
  if (!key) {
    console.error("\n  RATCHET_DEPLOYER_KEY missing from .env\n");
    process.exit(1);
  }
  const deployment = JSON.parse(readFileSync(OUT, "utf8"));
  const feed = deployment.contracts.pinnedFeed;

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

  const [, before, , updatedAt] = await publicClient.readContract({
    address: feed,
    abi: FEED.abi,
    functionName: "latestRoundData",
  });
  const age = Math.floor(Date.now() / 1000) - Number(updatedAt);

  const live = await mainnetEurcUsd();
  console.log(`\n  feed      ${feed}`);
  console.log(`  holds     $${formatUnits(before, 8)} (${(age / 3600).toFixed(1)}h old)`);
  console.log(`  mainnet   $${formatUnits(live.answer, live.decimals)}`);

  const hash = await wallet.writeContract({
    address: feed,
    abi: FEED.abi,
    functionName: "publish",
    args: [live.answer],
    account,
    chain: arcTestnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`publish reverted: ${hash}`);
  console.log(`  published ${hash}\n`);
}

main().catch((err) => {
  console.error("\n  publish failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
