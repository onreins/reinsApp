/**
 * Generate throwaway keypairs for testnet.
 *
 *   npm run keygen          # one key
 *   npm run keygen -- 3     # three
 *
 * These are printed in plaintext and are for testnet only. Do not put a key
 * that holds real funds into an environment variable.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const count = Math.max(1, Number(process.argv[2] ?? 1));

console.log("\n  Testnet keys — fund the addresses at https://faucet.circle.com\n");

for (let i = 0; i < count; i++) {
  const key = generatePrivateKey();
  const { address } = privateKeyToAccount(key);
  console.log(`  address  ${address}`);
  console.log(`  key      ${key}\n`);
}

console.log("  Testnet only. Never reuse these anywhere that holds real value.\n");
