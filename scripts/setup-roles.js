/**
 * Give the provider and evaluator their own keys and a little gas.
 *
 *   node --env-file=.env scripts/setup-roles.js
 *
 * A real ERC-8183 job needs three distinct parties — client, provider and
 * evaluator. An evaluator that shares a key with the client is exactly the
 * self-evaluation hole this project exists to close, so the demo refuses to
 * cut that corner even on testnet.
 *
 * Generates RATCHET_PROVIDER_KEY and RATCHET_EVALUATOR_KEY into .env if they
 * are missing (never overwriting existing ones), then tops each up from the
 * deployer to a small gas float. Testnet only; refuses to run on mainnet.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { formatUsdc } from "../src/usdc.js";

if ((process.env.RATCHET_NETWORK ?? "testnet") !== "testnet") {
  console.error("\n  setup-roles is testnet-only. It moves funds between keys it generated.\n");
  process.exit(1);
}

const deployerKey = process.env.RATCHET_DEPLOYER_KEY;
if (!deployerKey) {
  console.error("\n  RATCHET_DEPLOYER_KEY is not set. Run with --env-file=.env.\n");
  process.exit(1);
}

/** Gas float per role. Arc gas is paid in USDC, and a few cents covers many txs. */
const FLOAT = parseUnits("0.5", 18);

const envFile = ".env";
const env = readFileSync(envFile, "utf8");

function ensureKey(name) {
  if (process.env[name]) return process.env[name];
  if (new RegExp(`^${name}=`, "m").test(env)) {
    throw new Error(`${name} is in .env but not loaded — run with --env-file=.env`);
  }
  const key = generatePrivateKey();
  appendFileSync(envFile, `${name}=${key}\n`);
  console.log(`  generated ${name} (written to .env, which is gitignored)`);
  return key;
}

const chain = arcTestnet;
const publicClient = createPublicClient({ chain, transport: http() });
const deployer = privateKeyToAccount(deployerKey);
const wallet = createWalletClient({ account: deployer, chain, transport: http() });

const roles = {
  provider: privateKeyToAccount(ensureKey("RATCHET_PROVIDER_KEY")),
  evaluator: privateKeyToAccount(ensureKey("RATCHET_EVALUATOR_KEY")),
};

console.log(`\n  client/deployer  ${deployer.address}`);
for (const [role, acct] of Object.entries(roles)) {
  const balance = await publicClient.getBalance({ address: acct.address });
  if (balance >= FLOAT / 2n) {
    console.log(`  ${role.padEnd(16)} ${acct.address}  $${formatUsdc(balance)} (enough)`);
    continue;
  }
  const hash = await wallet.sendTransaction({
    account: deployer,
    chain,
    to: acct.address,
    value: FLOAT - balance,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.getBalance({ address: acct.address });
  console.log(`  ${role.padEnd(16)} ${acct.address}  topped up to $${formatUsdc(after)}`);
}

const left = await publicClient.getBalance({ address: deployer.address });
console.log(`\n  deployer balance now $${formatUsdc(left)}\n`);
