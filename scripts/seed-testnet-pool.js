/**
 * Create and fund the USDC/EURC Uniswap v4 pool on Arc testnet.
 *
 *   node --env-file=.env scripts/seed-testnet-pool.js --dry-run
 *   node --env-file=.env scripts/seed-testnet-pool.js
 *
 * Arc mainnet has a liquid USDC/EURC pool already. Testnet has none, so before a
 * mandate can trade there, somebody has to be the market: this mints one
 * position around the mainnet oracle price, out of the deployer's own testnet
 * USDC and EURC.
 *
 * The pool, the PoolManager and the PositionManager are the real Uniswap v4
 * deployment. Only the liquidity is ours.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  formatUnits,
  parseUnits,
  concatHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { ARC_TESTNET, OUT, mainnetEurcUsd } from "./deploy-testnet.js";

// How much of our own money becomes the market.
const USDC_TO_POOL = parseUnits("6", 6);
// A generous band around the current price, so ordinary trades stay in range.
const TICK_LOWER = -2300;
const TICK_UPPER = -300;

const MINT_POSITION = 0x02;
const SETTLE_PAIR = 0x0d;

const ERC20_ABI = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

const PERMIT2_ABI = [
  {
    type: "function", name: "approve", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }],
  },
];

const POOL_KEY_TYPE = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
};

const POSM_ABI = [
  { type: "function", name: "initializePool", stateMutability: "payable", outputs: [{ type: "int24" }], inputs: [POOL_KEY_TYPE, { type: "uint160" }] },
  { type: "function", name: "modifyLiquidities", stateMutability: "payable", outputs: [], inputs: [{ type: "bytes" }, { type: "uint256" }] },
  { type: "function", name: "multicall", stateMutability: "payable", outputs: [{ type: "bytes[]" }], inputs: [{ type: "bytes[]" }] },
  { type: "function", name: "nextTokenId", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
];

const STATE_ABI = [
  {
    type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] },
];

const Q96 = 2 ** 96;

/** Uniswap's pool identity: keccak of the encoded key, currencies sorted. */
export function poolIdOf(key) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const sqrtPriceX96From = (priceToken1PerToken0) => BigInt(Math.floor(Math.sqrt(priceToken1PerToken0) * Q96));
const sqrtRatioAt = (tick) => Math.pow(1.0001, tick / 2);
const tickAt = (price) => Math.log(price) / Math.log(1.0001);

/**
 * Liquidity that consumes `amount0` of currency0 at the current price, and the
 * amount of currency1 it will pull alongside it. Standard v4 range maths.
 */
export function liquidityFor(amount0, sqrtP, sqrtA, sqrtB) {
  const perUnit = (sqrtB - sqrtP) / (sqrtP * sqrtB);
  const liquidity = Number(amount0) / perUnit;
  return { liquidity: BigInt(Math.floor(liquidity)), amount1: BigInt(Math.ceil(liquidity * (sqrtP - sqrtA))) };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env.RATCHET_DEPLOYER_KEY;
  if (!key) {
    console.error("\n  RATCHET_DEPLOYER_KEY missing from .env\n");
    process.exit(1);
  }

  const deployment = JSON.parse(readFileSync(OUT, "utf8"));
  if (deployment.pool) {
    console.log(`\n  ${OUT} already records a pool (${deployment.pool.poolId}).\n  Refusing to seed twice.\n`);
    process.exit(1);
  }

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const { usdc, eurc, permit2, positionManager, stateView, route } = ARC_TESTNET;

  const [c0, c1] = BigInt(usdc) < BigInt(eurc) ? [usdc, eurc] : [eurc, usdc];
  const poolKey = { currency0: c0, currency1: c1, fee: route.fee, tickSpacing: route.tickSpacing, hooks: route.hooks };
  const poolId = poolIdOf(poolKey);

  // currency0 is USDC, currency1 is EURC, both 6 decimals, so the raw ratio is
  // simply EURC per USDC: the reciprocal of the EURC/USD oracle answer.
  const oracle = await mainnetEurcUsd();
  const usdPerEurc = Number(formatUnits(oracle.answer, oracle.decimals));
  const price = 1 / usdPerEurc;
  const sqrtPriceX96 = sqrtPriceX96From(price);

  const { liquidity, amount1 } = liquidityFor(
    USDC_TO_POOL,
    Math.sqrt(price),
    sqrtRatioAt(TICK_LOWER),
    sqrtRatioAt(TICK_UPPER),
  );

  console.log(`\n  Arc testnet · ${account.address}`);
  console.log(`  oracle     $${usdPerEurc.toFixed(6)} per EURC  →  ${price.toFixed(6)} EURC per USDC`);
  console.log(`  pool       fee ${route.fee}, spacing ${route.tickSpacing}, tick ${tickAt(price).toFixed(1)}`);
  console.log(`  range      ticks ${TICK_LOWER} … ${TICK_UPPER}`);
  console.log(`  liquidity  ${liquidity}`);
  console.log(`  costs      ${formatUnits(USDC_TO_POOL, 6)} USDC + ${formatUnits(amount1, 6)} EURC`);
  console.log(`  poolId     ${poolId}`);

  const [haveUsdc, haveEurc] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: eurc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`  balances   ${formatUnits(haveUsdc, 6)} USDC · ${formatUnits(haveEurc, 6)} EURC`);
  if (haveUsdc < USDC_TO_POOL || haveEurc < amount1) {
    console.error("\n  Not enough of one side to seed the pool.\n");
    process.exit(1);
  }

  // A little headroom: the exact amounts depend on rounding inside the pool.
  const max0 = (USDC_TO_POOL * 102n) / 100n;
  const max1 = (amount1 * 102n) / 100n;

  if (dryRun) {
    console.log(`\n  dry run: nothing sent.\n`);
    return;
  }

  const send = async (label, request) => {
    const hash = await wallet.writeContract({ ...request, account, chain: arcTestnet });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`  ${label.padEnd(22)} ${hash}`);
    return hash;
  };

  console.log("");
  const MAX_UINT160 = 2n ** 160n - 1n;
  const expiration = Math.floor(Date.now() / 1000) + 30 * 86_400;
  const txs = {};
  for (const [name, token, amount] of [["USDC", usdc, max0], ["EURC", eurc, max1]]) {
    txs[`approve${name}`] = await send(`approve ${name} → permit2`, {
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [permit2, amount],
    });
    txs[`permit${name}`] = await send(`permit2 ${name} → posm`, {
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [token, positionManager, amount > MAX_UINT160 ? MAX_UINT160 : amount, expiration],
    });
  }

  const actions = concatHex([toHex(MINT_POSITION, { size: 1 }), toHex(SETTLE_PAIR, { size: 1 })]);
  const mintParams = encodeAbiParameters(
    [
      POOL_KEY_TYPE,
      { type: "int24" }, { type: "int24" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" },
      { type: "address" }, { type: "bytes" },
    ],
    [poolKey, TICK_LOWER, TICK_UPPER, liquidity, max0, max1, account.address, "0x"],
  );
  const settleParams = encodeAbiParameters([{ type: "address" }, { type: "address" }], [c0, c1]);
  const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [mintParams, settleParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  txs.seed = await send("initialize + mint", {
    address: positionManager,
    abi: POSM_ABI,
    functionName: "multicall",
    args: [
      [
        encodeFunctionData({ abi: POSM_ABI, functionName: "initializePool", args: [poolKey, sqrtPriceX96] }),
        encodeFunctionData({ abi: POSM_ABI, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
      ],
    ],
  });

  const [slot0, live] = await Promise.all([
    publicClient.readContract({ address: stateView, abi: STATE_ABI, functionName: "getSlot0", args: [poolId] }),
    publicClient.readContract({ address: stateView, abi: STATE_ABI, functionName: "getLiquidity", args: [poolId] }),
  ]);
  const spot = (Q96 / Number(slot0[0])) ** 2;
  console.log(`\n  pool is live: tick ${slot0[1]}, liquidity ${live}, $${spot.toFixed(6)} per EURC`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        ...deployment,
        pool: {
          poolId,
          key: poolKey,
          sqrtPriceX96: sqrtPriceX96.toString(),
          tick: slot0[1],
          tickLower: TICK_LOWER,
          tickUpper: TICK_UPPER,
          liquidity: live.toString(),
          seeded: { usdc: formatUnits(USDC_TO_POOL, 6), eurc: formatUnits(amount1, 6) },
          txs,
          note: "Liquidity is ours. Arc testnet has no USDC/EURC market, so we made one.",
          seededAt: new Date().toISOString(),
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  updated ${OUT}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\n  seeding failed:", err.shortMessage ?? err.message);
    if (err.metaMessages) console.error(err.metaMessages.join("\n"));
    process.exit(1);
  });
}
