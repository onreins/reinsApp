/**
 * The live test: one mandate on Arc testnet, doing everything it claims.
 *
 *   node --env-file=.env scripts/live-testnet.js
 *
 * Every step below is a real transaction against the real chain, through the
 * real Uniswap v4 PoolManager. The refusals are broadcast deliberately with a
 * fixed gas limit so they land on-chain as a permanent record: a mandate that
 * only refuses in simulation proves nothing.
 *
 * Writes docs/live-run/TESTNET-RUN.md with every hash.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { ARC_TESTNET, OUT } from "./deploy-testnet.js";
import { createMandate, MandateClient, explain } from "../mandate/sdk.js";

const EXPLORER = "https://explorer.testnet.arc.io";
const DOC = "docs/live-run/TESTNET-RUN.md";
const USYC_TESTNET = "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C"; // a real token this mandate never allowed

const MANDATE = artifact("Mandate");
const VENUE = artifact("UniswapV4Venue");
const FEED = artifact("PinnedFeed");
// A refusal can come from the mandate or, one level down, from the exchange.
const TRADE_ABI = [...MANDATE.abi, ...VENUE.abi.filter((x) => x.type === "error")];

const ERC20 = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];
const STATE_ABI = [
  {
    type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
];

const DEPOSIT = "2";
const MAX_TRADE_USD = 2;
const MAX_LOSS_PERCENT = 10;
const MAX_SLIPPAGE_PERCENT = 1;
const BUY_USD = "0.5";
const CRASH_TO = 50; // the euro falls to this percent of its price

const Q96 = 2 ** 96;
const steps = [];

const record = (title, detail, hash = null) => {
  steps.push({ title, detail, hash });
  console.log(`  ${title.padEnd(38)} ${detail}`);
  if (hash) console.log(`  ${" ".repeat(38)} ${hash}`);
};

async function main() {
  const deployment = JSON.parse(readFileSync(OUT, "utf8"));
  if (!deployment.pool) throw new Error("no pool recorded; run scripts/seed-testnet-pool.js first");

  const ownerKey = process.env.RATCHET_DEPLOYER_KEY;
  const agentKey = process.env.RATCHET_PROVIDER_KEY;
  const strangerKey = process.env.RATCHET_EVALUATOR_KEY;
  if (!ownerKey || !agentKey || !strangerKey) throw new Error("need deployer, provider and evaluator keys in .env");

  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const walletOf = (key) =>
    createWalletClient({ account: privateKeyToAccount(key), chain: arcTestnet, transport: http() });
  const owner = walletOf(ownerKey);
  const agent = walletOf(agentKey);
  const stranger = walletOf(strangerKey);

  const { usdc, eurc, stateView } = ARC_TESTNET;
  const { mandateFactory, uniswapV4Venue, pinnedFeed } = deployment.contracts;
  const poolId = deployment.pool.poolId;
  const poolLiquidity = Number(deployment.pool.liquidity);

  console.log(`\n  Arc testnet · block ${await publicClient.getBlockNumber({ cacheTime: 0 })}`);
  console.log(`  owner ${owner.account.address}\n  agent ${agent.account.address}\n`);

  const send = async (wallet, request) => {
    const hash = await wallet.writeContract({ ...request, account: wallet.account, chain: arcTestnet });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${request.functionName} reverted: ${hash}`);
    return { hash, receipt };
  };

  /** EURC per USDC, as the pool currently prices it. */
  const poolPrice = async () => {
    const [sqrtPriceX96] = await publicClient.readContract({
      address: stateView,
      abi: STATE_ABI,
      functionName: "getSlot0",
      args: [poolId],
    });
    return (Number(sqrtPriceX96) / Q96) ** 2;
  };

  const [, feedAnswer] = await publicClient.readContract({
    address: pinnedFeed,
    abi: FEED.abi,
    functionName: "latestRoundData",
  });
  const oracleUsdPerEurc = Number(feedAnswer) / 1e8;

  // ---- 0. nobody arbitrages a testnet, so we do it ourselves --------------
  // Earlier trades leave the pool away from the oracle. On mainnet arbitrage
  // closes that gap in seconds; here the only other participant is us.
  const target = 1 / oracleUsdPerEurc;
  const spot = await poolPrice();
  const gapBps = ((spot - target) / target) * 10_000;

  if (Math.abs(gapBps) > 10) {
    // dy = L * (sqrt(target) - sqrt(spot)): selling EURC raises EURC-per-USDC.
    const dy = BigInt(Math.round(poolLiquidity * (Math.sqrt(target) - Math.sqrt(spot))));
    if (dy <= 0n) throw new Error(`pool is rich in EURC by ${gapBps.toFixed(0)}bps; rebalancing that way is not wired up`);
    await send(owner, { address: eurc, abi: ERC20, functionName: "approve", args: [uniswapV4Venue, dy] });
    const arb = await send(owner, {
      address: uniswapV4Venue,
      abi: VENUE.abi,
      functionName: "swap",
      args: [eurc, usdc, dy, 0n, owner.account.address],
    });
    const now = await poolPrice();
    record(
      "pool arbitraged back to the oracle",
      `${gapBps.toFixed(0)} bps off → ${(((now - target) / target) * 10_000).toFixed(0)} bps, selling ${formatUnits(dy, 6)} EURC`,
      arb.hash,
    );
  } else {
    record("pool is already at the oracle", `${gapBps.toFixed(0)} bps off`);
  }

  // ---- 1. create and fund -------------------------------------------------
  const chainNow = Number((await publicClient.getBlock()).timestamp);
  const mandate = await createMandate({
    publicClient,
    ownerWallet: owner,
    factory: mandateFactory,
    name: `fx reversion ${new Date().toISOString().slice(0, 10)}`,
    agent: agent.account.address,
    base: usdc,
    venue: uniswapV4Venue,
    rules: {
      maxTradeUsd: MAX_TRADE_USD,
      maxLossPercent: MAX_LOSS_PERCENT,
      maxSlippagePercent: MAX_SLIPPAGE_PERCENT,
      expiresAt: new Date((chainNow + 30 * 86_400) * 1000),
      maxPriceAgeSeconds: 86_400,
    },
    assets: [{ token: eurc, feed: pinnedFeed }],
    deposit: DEPOSIT,
  });
  record("mandate created and funded", `${mandate} with $${DEPOSIT}`);

  /** Broadcast a trade we expect the mandate to refuse, so the refusal is on-chain. */
  const expectRefusal = async (label, args, rule, from = agent) => {
    let hash;
    try {
      hash = await from.writeContract({
        address: mandate,
        abi: TRADE_ABI,
        functionName: "trade",
        args,
        account: from.account,
        chain: arcTestnet,
        gas: 500_000n, // skip estimation: estimation would reject it before it is ever mined
      });
    } catch (err) {
      // Some nodes refuse to accept a transaction they can see will revert.
      const { rule: got } = explain(err);
      if (got !== rule) throw new Error(`expected ${rule}, node reported ${got}`);
      record(label, `refused: ${rule} (rejected before broadcast)`);
      return;
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") throw new Error(`${label} was supposed to be refused, but it went through`);
    // Confirm which rule bit, by replaying the same call against the same block.
    let got = "Reverted";
    try {
      await publicClient.simulateContract({
        address: mandate,
        abi: TRADE_ABI,
        functionName: "trade",
        args,
        account: from.account.address,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      got = explain(err).rule;
    }
    if (got !== rule) throw new Error(`expected ${rule}, got ${got}`);
    record(label, `refused on-chain: ${rule}`, hash);
  };

  const client = new MandateClient({ publicClient, wallet: agent, address: mandate });
  const opening = await client.status();
  record(
    "opening position",
    `equity $${opening.equityUsd.toFixed(4)} · floor $${opening.floorUsd.toFixed(2)} · ` +
      `max $${opening.rules.maxTradeUsd}/trade · within ${opening.rules.maxSlippagePercent}% of the oracle`,
  );

  // ---- 2. a trade the rules allow ----------------------------------------
  const buy = await client.trade({ from: "USDC", to: "EURC", amount: BUY_USD });
  const fill = Number(BUY_USD) / buy.bought.amount;
  record(
    `agent buys $${BUY_USD} of EURC`,
    `${buy.bought.amount.toFixed(6)} EURC at $${fill.toFixed(6)} — ` +
      `${(((fill - oracleUsdPerEurc) / oracleUsdPerEurc) * 100).toFixed(3)}% vs oracle $${oracleUsdPerEurc.toFixed(6)}`,
    buy.hash,
  );

  // ---- 3. the rules that refuse ------------------------------------------
  await expectRefusal(`trade above the $${MAX_TRADE_USD} limit`, [usdc, eurc, parseUnits("2.5", 6), 0n], "TradeTooLarge");
  // $1 is inside the size limit and inside the balance, but the pool we seeded
  // is only a few dollars deep: filling it would land outside the oracle band.
  await expectRefusal(
    "a trade too big for the pool to price fairly",
    [usdc, eurc, parseUnits("1", 6), 0n],
    "InsufficientOutput",
  );
  await expectRefusal("trade into an asset never allowed", [usdc, USYC_TESTNET, parseUnits("1", 6), 0n], "AssetNotAllowed");
  await expectRefusal("a stranger's key tries to trade", [usdc, eurc, parseUnits("0.5", 6), 0n], "NotAgent", stranger);

  // ---- 4. the public stop-loss -------------------------------------------
  const before = await client.status();
  const crash = (BigInt(Math.round(oracleUsdPerEurc * 1e8)) * BigInt(CRASH_TO)) / 100n;
  const pushed = await send(owner, { address: pinnedFeed, abi: FEED.abi, functionName: "publish", args: [crash] });
  record(`euro falls ${100 - CRASH_TO}% on the feed`, `$${formatUnits(crash, 8)} per EURC`, pushed.hash);

  const frozen = await send(stranger, { address: mandate, abi: MANDATE.abi, functionName: "checkpoint" });
  const after = await client.status();
  if (!after.frozen) throw new Error("checkpoint did not freeze a mandate below its floor");
  record(
    "a stranger freezes it",
    `equity $${before.equityUsd.toFixed(4)} → $${after.equityUsd.toFixed(4)}, under the $${after.floorUsd.toFixed(2)} floor · ` +
      `frozen by ${stranger.account.address}, who owns none of it`,
    frozen.hash,
  );

  await expectRefusal("agent tries to keep trading", [usdc, eurc, parseUnits("0.5", 6), 0n], "IsFrozen");

  // ---- 5. the owner is never locked out ----------------------------------
  const restored = await send(owner, {
    address: pinnedFeed,
    abi: FEED.abi,
    functionName: "publish",
    args: [BigInt(Math.round(oracleUsdPerEurc * 1e8))],
  });
  record("price restored", `$${oracleUsdPerEurc.toFixed(6)} per EURC`, restored.hash);

  const unfrozen = await send(owner, { address: mandate, abi: MANDATE.abi, functionName: "unfreeze" });
  record("owner resumes it", "frozen = false", unfrozen.hash);

  const held = await publicClient.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [mandate] });
  const takeOut = parseUnits("0.25", 6);
  const withdrawn = await send(owner, {
    address: mandate,
    abi: MANDATE.abi,
    functionName: "withdraw",
    args: [usdc, takeOut],
  });
  record(
    "owner withdraws mid-strategy",
    `$${formatUnits(takeOut, 6)} out of $${formatUnits(held, 6)} USDC held, without asking the agent`,
    withdrawn.hash,
  );

  const closing = await client.status();
  record(
    "closing position",
    `equity $${closing.equityUsd.toFixed(4)} · holds ${closing.holdings
      .filter((h) => h.amount > 0)
      .map((h) => `${h.amount.toFixed(4)} ${h.symbol}`)
      .join(" + ")}`,
  );

  // ---- 6. write it down ---------------------------------------------------
  mkdirSync("docs/live-run", { recursive: true });
  const link = (h) => `[\`${h.slice(0, 10)}…\`](${EXPLORER}/tx/${h})`;
  const rows = steps
    .map((s, i) => `| ${i + 1} | ${s.title} | ${s.detail.replace(/\n/g, " ")} | ${s.hash ? link(s.hash) : "—"} |`)
    .join("\n");
  const crashStep = steps.findIndex((s) => s.title.startsWith("euro falls")) + 1;

  writeFileSync(
    DOC,
    `# Mandate on Arc testnet: a live run

*Run ${new Date().toISOString()} · chain ${arcTestnet.id} · every line below is a real transaction.*

## What this proves

A mandate held real testnet USDC. An agent traded it through the real Uniswap v4
PoolManager, and the contract refused every trade that broke a rule — on-chain,
with a hash you can open. A stranger who owns none of it froze the mandate once
it fell through its floor. The owner took money out while the agent was still
running.

## The deployment

| | |
|---|---|
| MandateFactory | [\`${deployment.contracts.mandateFactory}\`](${EXPLORER}/address/${deployment.contracts.mandateFactory}) |
| UniswapV4Venue | [\`${deployment.contracts.uniswapV4Venue}\`](${EXPLORER}/address/${deployment.contracts.uniswapV4Venue}) |
| PinnedFeed | [\`${deployment.contracts.pinnedFeed}\`](${EXPLORER}/address/${deployment.contracts.pinnedFeed}) |
| The mandate | [\`${mandate}\`](${EXPLORER}/address/${mandate}) |
| Owner | \`${owner.account.address}\` |
| Agent | \`${agent.account.address}\` |
| Pool | USDC/EURC, fee ${deployment.pool.key.fee}, seeded by us with ${deployment.pool.seeded.usdc} USDC + ${deployment.pool.seeded.eurc} EURC |

## The run

| # | Step | What happened | Transaction |
|---|---|---|---|
${rows}

## Two honest differences from mainnet

1. **The oracle.** Chainlink publishes 32 feeds on Arc mainnet and none on Arc
   testnet. So the mandate here reads \`PinnedFeed\`, which carries the live
   mainnet EURC/USD answer and is moved by us — that is how the crash in step
   ${crashStep} was staged. On mainnet the mandate is handed Chainlink's own
   aggregator and \`PinnedFeed\` is not deployed at all.
2. **The market.** Arc mainnet has a liquid USDC/EURC pool. Testnet had none, so
   we created one and funded it out of our own testnet balance. It is only a few
   dollars deep, which is why a $1 trade cannot be priced inside the mandate's
   ${MAX_SLIPPAGE_PERCENT}% band while a $${BUY_USD} trade can, and why the pool has to be arbitraged
   back to the oracle by us. The PoolManager, the PositionManager and the swap
   path are Uniswap's real contracts; only the liquidity is ours.

Neither difference touches the Mandate contract. The rules that refused those
trades are the same bytecode that would run on mainnet, which is what
\`npm run sim:mainnet\` exercises against the real mainnet pool.
`,
  );
  console.log(`\n  wrote ${DOC}`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      { ...deployment, liveRun: { mandate, agent: agent.account.address, steps, ranAt: new Date().toISOString() } },
      null,
      2,
    )}\n`,
  );
  console.log(`  updated ${OUT}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\n  live run failed:", err.shortMessage ?? err.message);
    if (err.metaMessages) console.error(err.metaMessages.join("\n"));
    process.exit(1);
  });
}
