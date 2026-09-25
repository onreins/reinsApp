/**
 * Deploy Mandate to Arc mainnet: the factory and a Uniswap v4 venue with the
 * USDC/EURC route fixed to the one liquid v4 pool.
 *
 *   node --env-file=.env scripts/deploy-mandate.js --dry-run   # estimate only
 *   node --env-file=.env scripts/deploy-mandate.js             # deploy
 *
 * Uses MANDATE_MAINNET_KEY (a fresh key, never the testnet deployer). Writes
 * public addresses to deployments/mainnet.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";

import { artifact } from "./artifact.js";

const ARC_MAINNET = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
  feeds: { EURC: "0x361b95c10b76Ca3f35C686d423e43A951755Bf23" },
  route: { fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" },
};
const OUT = "deployments/mainnet.json";

const dryRun = process.argv.includes("--dry-run");
const key = process.env.MANDATE_MAINNET_KEY;
if (!key) {
  console.error("\n  MANDATE_MAINNET_KEY missing from .env\n");
  process.exit(1);
}
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account, chain: arc, transport: http() });

const FACTORY = artifact("MandateFactory");
const VENUE = artifact("UniswapV4Venue");

async function main() {
  const balance = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice();
  console.log(`\n  Arc mainnet · deployer ${account.address}`);
  console.log(`  balance   ${formatEther(balance)} USDC   gas price ${Number(gasPrice) / 1e9} gwei`);

  if (existsSync(OUT)) {
    console.log(`\n  ${OUT} already exists: ${readFileSync(OUT, "utf8")}\n  Refusing to redeploy.\n`);
    process.exit(1);
  }

  const gasFactory = await publicClient.estimateGas({ account: account.address, data: FACTORY.bytecode });
  const gasVenue = await publicClient.estimateGas({
    account: account.address,
    data: encodeDeployData({ abi: VENUE.abi, bytecode: VENUE.bytecode, args: [ARC_MAINNET.poolManager, account.address] }),
  });
  const gasRoute = 80_000n; // setRoute: one storage write, estimated conservatively
  const total = (gasFactory + gasVenue + gasRoute) * gasPrice;
  console.log(`  estimate  factory ${gasFactory} gas · venue ${gasVenue} gas · route ~${gasRoute} gas`);
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
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain: arc });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`deploy reverted: ${hash}`);
    return { address: r.contractAddress, hash };
  };

  const factory = await deploy(FACTORY, []);
  console.log(`\n  MandateFactory   ${factory.address}`);
  const venue = await deploy(VENUE, [ARC_MAINNET.poolManager, account.address]);
  console.log(`  UniswapV4Venue   ${venue.address}`);
  const routeHash = await wallet.writeContract({
    address: venue.address,
    abi: VENUE.abi,
    functionName: "setRoute",
    args: [ARC_MAINNET.usdc, ARC_MAINNET.eurc, ARC_MAINNET.route.fee, ARC_MAINNET.route.tickSpacing, ARC_MAINNET.route.hooks],
    account,
    chain: arc,
  });
  await publicClient.waitForTransactionReceipt({ hash: routeHash });
  console.log(`  route USDC/EURC  fee ${ARC_MAINNET.route.fee}, fixed for good`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        network: "mainnet",
        chainId: arc.id,
        deployer: account.address,
        contracts: { mandateFactory: factory.address, uniswapV4Venue: venue.address },
        txs: { mandateFactory: factory.hash, uniswapV4Venue: venue.hash, setRoute: routeHash },
        external: ARC_MAINNET,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n  wrote ${OUT}\n`);
}

main().catch((err) => {
  console.error("\n  deploy failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
