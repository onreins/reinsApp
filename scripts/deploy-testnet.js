/**
 * Stand up Mandate on Arc testnet: the factory, a Uniswap v4 venue, and a price
 * feed.
 *
 *   node --env-file=.env scripts/deploy-testnet.js --dry-run   # estimate only
 *   node --env-file=.env scripts/deploy-testnet.js             # deploy
 *
 * Two things differ from mainnet, and both are stated here rather than hidden:
 *
 *  - Chainlink does not publish to Arc testnet, so we deploy a PinnedFeed and
 *    copy the live mainnet EURC/USD answer into it. On mainnet the mandate is
 *    given Chainlink's own aggregator and this contract is not deployed at all.
 *  - No USDC/EURC pool exists on testnet, so one has to be created and funded
 *    before anything can trade: run scripts/seed-testnet-pool.js next.
 *
 * Uses RATCHET_DEPLOYER_KEY, which is testnet-only and must never hold value.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, formatEther, formatUnits, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";

export const ARC_TESTNET = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  route: { fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" },
};
const MAINNET_EURC_FEED = "0x361b95c10b76Ca3f35C686d423e43A951755Bf23";
export const OUT = "deployments/mandate-testnet.json";

const FEED_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  {
    type: "function", name: "latestRoundData", inputs: [], stateMutability: "view",
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
];

/** Read the live mainnet EURC/USD answer, so the testnet feed starts honest. */
export async function mainnetEurcUsd() {
  const client = createPublicClient({ chain: arc, transport: http() });
  const [[, answer, , updatedAt], decimals] = await Promise.all([
    client.readContract({ address: MAINNET_EURC_FEED, abi: FEED_ABI, functionName: "latestRoundData" }),
    client.readContract({ address: MAINNET_EURC_FEED, abi: FEED_ABI, functionName: "decimals" }),
  ]);
  return { answer, decimals, updatedAt: Number(updatedAt) };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env.RATCHET_DEPLOYER_KEY;
  if (!key) {
    console.error("\n  RATCHET_DEPLOYER_KEY missing from .env\n");
    process.exit(1);
  }

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

  const FACTORY = artifact("MandateFactory");
  const VENUE = artifact("UniswapV4Venue");
  const FEED = artifact("PinnedFeed");

  const [balance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getGasPrice(),
  ]);
  console.log(`\n  Arc testnet · deployer ${account.address}`);
  console.log(`  balance   ${formatEther(balance)} USDC   gas price ${Number(gasPrice) / 1e9} gwei`);

  const price = await mainnetEurcUsd();
  const age = Math.floor(Date.now() / 1000) - price.updatedAt;
  console.log(`  oracle    mainnet Chainlink EURC/USD $${formatUnits(price.answer, price.decimals)} (${age}s old)`);

  if (existsSync(OUT)) {
    console.log(`\n  ${OUT} already exists:\n${readFileSync(OUT, "utf8")}\n  Refusing to redeploy.\n`);
    process.exit(1);
  }

  const feedArgs = [price.decimals, "EURC / USD (pinned from Arc mainnet Chainlink)", price.answer];
  const venueArgs = [ARC_TESTNET.poolManager, account.address];
  const [gasFactory, gasVenue, gasFeed] = await Promise.all([
    publicClient.estimateGas({ account: account.address, data: FACTORY.bytecode }),
    publicClient.estimateGas({
      account: account.address,
      data: encodeDeployData({ abi: VENUE.abi, bytecode: VENUE.bytecode, args: venueArgs }),
    }),
    publicClient.estimateGas({
      account: account.address,
      data: encodeDeployData({ abi: FEED.abi, bytecode: FEED.bytecode, args: feedArgs }),
    }),
  ]);
  const gasRoute = 80_000n; // setRoute: one storage write, estimated conservatively
  const total = (gasFactory + gasVenue + gasFeed + gasRoute) * gasPrice;
  console.log(`  estimate  factory ${gasFactory} · venue ${gasVenue} · feed ${gasFeed} · route ~${gasRoute}`);
  console.log(`            ≈ ${formatEther(total)} USDC total`);

  if (dryRun) {
    console.log(`\n  dry run: nothing sent.${balance < total ? " Fund the deployer first." : ""}\n`);
    return;
  }
  if (balance < (total * 3n) / 2n) {
    console.error(`\n  Not enough USDC for gas (need ~${formatEther((total * 3n) / 2n)} with headroom).\n`);
    process.exit(1);
  }

  const deploy = async (art, args) => {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain: arcTestnet });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`deploy reverted: ${hash}`);
    return { address: receipt.contractAddress, hash };
  };

  const factory = await deploy(FACTORY, []);
  // The arena has to start reading somewhere; scanning from genesis would be
  // millions of blocks of nothing.
  const fromBlock = (await publicClient.getTransactionReceipt({ hash: factory.hash })).blockNumber;
  console.log(`\n  MandateFactory   ${factory.address}`);
  const venue = await deploy(VENUE, venueArgs);
  console.log(`  UniswapV4Venue   ${venue.address}`);
  const feed = await deploy(FEED, feedArgs);
  console.log(`  PinnedFeed       ${feed.address}`);

  const routeHash = await wallet.writeContract({
    address: venue.address,
    abi: VENUE.abi,
    functionName: "setRoute",
    args: [
      ARC_TESTNET.usdc,
      ARC_TESTNET.eurc,
      ARC_TESTNET.route.fee,
      ARC_TESTNET.route.tickSpacing,
      ARC_TESTNET.route.hooks,
    ],
    account,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash: routeHash });
  console.log(`  route USDC/EURC  fee ${ARC_TESTNET.route.fee}, fixed for good`);

  mkdirSync("deployments", { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        network: "testnet",
        chainId: arcTestnet.id,
        deployer: account.address,
        fromBlock: fromBlock.toString(),
        contracts: {
          mandateFactory: factory.address,
          uniswapV4Venue: venue.address,
          pinnedFeed: feed.address,
        },
        txs: {
          mandateFactory: factory.hash,
          uniswapV4Venue: venue.hash,
          pinnedFeed: feed.hash,
          setRoute: routeHash,
        },
        external: ARC_TESTNET,
        oracleNote: "PinnedFeed carries the mainnet Chainlink answer; Chainlink does not publish to Arc testnet.",
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n  wrote ${OUT}\n`);
}

// Only deploy when run directly; the other testnet scripts import the constants.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\n  deploy failed:", err.shortMessage ?? err.message);
    process.exit(1);
  });
}
