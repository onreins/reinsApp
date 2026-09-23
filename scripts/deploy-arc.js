/**
 * Deploy the stack to Arc.
 *
 *   RATCHET_DEPLOYER_KEY=0x... npm run deploy:arc              # testnet
 *   RATCHET_DEPLOYER_KEY=0x... RATCHET_NETWORK=mainnet npm run deploy:arc
 *
 * Deploys AgenticCommerce (ERC-8183 job escrow) and, with --with-vault, the
 * RatchetVault payment channel. Records every address in deployments/<net>.json
 * so the evaluator, the service and the demo can all find them without anyone
 * copying hex strings around.
 *
 * Environment:
 *   RATCHET_DEPLOYER_KEY   funded key (required)
 *   RATCHET_NETWORK        testnet | mainnet        (default: testnet)
 *   RATCHET_RPC            override the RPC url
 *   RATCHET_USDC           override the USDC token address
 *   RATCHET_FEE_BPS        protocol fee, max 250    (default: 0)
 *   RATCHET_FEE_RECIPIENT  where the fee goes       (default: deployer)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { formatUsdc } from "../src/usdc.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const NETWORK = process.env.RATCHET_NETWORK ?? "testnet";
const chain = NETWORK === "mainnet" ? arc : arcTestnet;

const EXPLORER = {
  mainnet: "https://explorer.arc.io",
  testnet: "https://explorer.testnet.arc.io",
}[NETWORK];

/**
 * USDC's ERC-20 interface on Arc.
 *
 * Taken from the asset address Circle's own Gateway facilitator names in the
 * x402 challenge it issues for Arc testnet, so it is their figure rather than
 * ours. Override if Circle moves it.
 */
const USDC_ADDRESS = process.env.RATCHET_USDC ?? "0x3600000000000000000000000000000000000000";

const WITH_VAULT = process.argv.includes("--with-vault");
const FEE_BPS = Number(process.env.RATCHET_FEE_BPS ?? 0);

const key = process.env.RATCHET_DEPLOYER_KEY;
if (!key) {
  console.error(
    [
      "",
      "  RATCHET_DEPLOYER_KEY is not set.",
      "",
      "  1. Create a key:      npm run keygen",
      "  2. Fund the address:  https://faucet.circle.com  (network: Arc testnet)",
      "  3. Deploy:            RATCHET_DEPLOYER_KEY=0x... npm run deploy:arc",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!Number.isInteger(FEE_BPS) || FEE_BPS < 0 || FEE_BPS > 250) {
  console.error(
    `\n  RATCHET_FEE_BPS must be an integer 0-250 (got ${process.env.RATCHET_FEE_BPS}).\n`,
  );
  process.exit(1);
}

const account = privateKeyToAccount(key);
const rpcUrl = process.env.RATCHET_RPC ?? chain.rpcUrls.default.http[0];
const feeRecipient = process.env.RATCHET_FEE_RECIPIENT ?? account.address;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const bar = (n = 72) => "─".repeat(n);

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  process.stdout.write(`  deploying ${name}... `);

  const hash = await wallet.deployContract({ abi, bytecode, args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    console.log("FAILED");
    throw new Error(`${name} deployment reverted — ${EXPLORER}/tx/${hash}`);
  }

  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  console.log(`${receipt.contractAddress}  ($${formatUsdc(fee, 8)})`);
  return { address: receipt.contractAddress, hash, gasUsed: receipt.gasUsed, fee };
}

async function main() {
  console.log(`\n${bar()}`);
  console.log(`  Deploying to ${chain.name} (chain ${chain.id})`);
  console.log(bar());
  console.log(`  rpc        ${rpcUrl}`);
  console.log(`  deployer   ${account.address}`);
  console.log(`  USDC       ${USDC_ADDRESS}`);
  console.log(`  fee        ${FEE_BPS} bps${FEE_BPS ? ` -> ${feeRecipient}` : " (none)"}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`  balance    $${formatUsdc(balance)} USDC\n`);

  if (balance === 0n) {
    console.error(
      [
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

  // Refuse to deploy against an address with no code — a typo here would
  // produce an escrow that silently cannot move money.
  const usdcCode = await publicClient.getCode({ address: USDC_ADDRESS }).catch(() => undefined);
  if (!usdcCode || usdcCode === "0x") {
    console.error(
      `  No contract at ${USDC_ADDRESS}.\n` +
        `  Set RATCHET_USDC to Arc's USDC token address and retry.\n`,
    );
    process.exit(1);
  }

  const deployed = {};
  let spent = 0n;

  const commerce = await deploy("AgenticCommerce", [USDC_ADDRESS, FEE_BPS, feeRecipient]);
  deployed.agenticCommerce = commerce.address;
  spent += commerce.fee;

  if (WITH_VAULT) {
    const vault = await deploy("RatchetVault");
    deployed.ratchetVault = vault.address;
    spent += vault.fee;
  }

  // --- record ------------------------------------------------------------
  const dir = join(root, "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${NETWORK}.json`);

  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const record = {
    ...previous,
    network: NETWORK,
    chainId: chain.id,
    rpc: rpcUrl,
    usdc: USDC_ADDRESS,
    deployer: account.address,
    feeBps: FEE_BPS,
    feeRecipient: FEE_BPS ? feeRecipient : null,
    contracts: { ...(previous.contracts ?? {}), ...deployed },
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\n${bar()}`);
  console.log("  DEPLOYED");
  console.log(bar());
  for (const [name, address] of Object.entries(deployed)) {
    console.log(`  ${name.padEnd(18)} ${address}`);
    console.log(`  ${"".padEnd(18)} ${EXPLORER}/address/${address}`);
  }
  console.log(`\n  total gas paid     $${formatUsdc(spent, 8)} USDC`);
  console.log(`  recorded in        deployments/${NETWORK}.json`);

  console.log(`\n  Next:`);
  console.log(`    # sell sandboxed compute, settled by Circle Gateway`);
  console.log(`    RATCHET_SELLER_ADDRESS=0x... RATCHET_NETWORK=${NETWORK} npm run serve:x402`);
  console.log(`${bar()}\n`);
}

main().catch((err) => {
  console.error("\n  deploy failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
