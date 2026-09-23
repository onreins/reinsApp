/**
 * Deploy RatchetVault to Arc.
 *
 *   RATCHET_DEPLOYER_KEY=0x... node scripts/deploy.js            # testnet (default)
 *   RATCHET_DEPLOYER_KEY=0x... RATCHET_NETWORK=mainnet node scripts/deploy.js
 *
 * The vault is unowned and has no admin functions, so one deployment can serve
 * every provider on the network — deploy your own only if you want to.
 */
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import { VAULT_ABI, VAULT_BYTECODE } from "../src/vault.js";
import { formatUsdc } from "../src/usdc.js";

const NETWORK = process.env.RATCHET_NETWORK ?? "testnet";
const chain = NETWORK === "mainnet" ? arc : arcTestnet;

const EXPLORER = {
  mainnet: "https://explorer.arc.io",
  testnet: "https://explorer.testnet.arc.io",
}[NETWORK];

const key = process.env.RATCHET_DEPLOYER_KEY;
if (!key) {
  console.error(
    [
      "",
      "  RATCHET_DEPLOYER_KEY is not set.",
      "",
      "  1. Create a key:       npm run keygen",
      "  2. Fund the address:   https://faucet.circle.com  (network: Arc testnet)",
      "  3. Deploy:             RATCHET_DEPLOYER_KEY=0x... npm run deploy",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const account = privateKeyToAccount(key);
const rpcUrl = process.env.RATCHET_RPC ?? chain.rpcUrls.default.http[0];

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const main = async () => {
  console.log(`\n  network   ${chain.name} (chain id ${chain.id})`);
  console.log(`  rpc       ${rpcUrl}`);
  console.log(`  deployer  ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`  balance   $${formatUsdc(balance)} USDC`);

  if (balance === 0n) {
    console.error(
      [
        "",
        `  This account has no USDC, so it cannot pay for gas.`,
        `  Fund it at https://faucet.circle.com (network: Arc ${NETWORK}):`,
        "",
        `      ${account.address}`,
        "",
        "  Then run this again.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  // Gas on Arc is paid in USDC, so this estimate is denominated in dollars.
  // Fall back to a measured figure if the node declines to estimate.
  const fees = await publicClient.estimateFeesPerGas();
  const gasPrice = fees.maxFeePerGas ?? 20_000_000_000n;
  let gas;
  try {
    gas = await publicClient.estimateGas({ account, data: VAULT_BYTECODE });
  } catch {
    gas = 1_450_000n; // measured deployment cost, with headroom
    console.log("  (gas estimation declined; using a measured fallback)");
  }

  const cost = gas * gasPrice;
  console.log(
    `  est. cost $${formatUsdc(cost, 8)} USDC (${gas} gas @ ${formatUnits(gasPrice, 9)} gwei)`,
  );

  if (balance < cost) {
    console.error(
      `\n  Not enough USDC: need ~$${formatUsdc(cost, 8)}, have $${formatUsdc(balance)}.` +
        `\n  Top up ${account.address} at https://faucet.circle.com and retry.\n`,
    );
    process.exit(1);
  }

  process.stdout.write("\n  deploying... ");
  const hash = await wallet.deployContract({ abi: VAULT_ABI, bytecode: VAULT_BYTECODE, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    console.error(`failed\n  tx ${EXPLORER}/tx/${hash}\n`);
    process.exit(1);
  }

  const paid = receipt.gasUsed * receipt.effectiveGasPrice;
  console.log("done\n");
  console.log(`  vault     ${receipt.contractAddress}`);
  console.log(`  tx        ${EXPLORER}/tx/${hash}`);
  console.log(`  explorer  ${EXPLORER}/address/${receipt.contractAddress}`);
  console.log(`  paid      $${formatUsdc(paid, 8)} USDC (${receipt.gasUsed} gas)`);
  console.log(`\n  Run the demo against it:`);
  console.log(
    `    RATCHET_RPC=${rpcUrl} RATCHET_VAULT=${receipt.contractAddress} \\\n` +
      `    RATCHET_PAYER_KEY=0x... RATCHET_PROVIDER_KEY=0x... npm run demo\n`,
  );
};

main().catch((err) => {
  console.error("\n  deploy failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
