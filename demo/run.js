/**
 * End-to-end demo: an agent pays for N API calls, and we count exactly what it
 * cost on-chain.
 *
 * All accounting is derived from the vault's own event logs after the fact, so
 * the numbers printed are measured, not estimated.
 *
 * Local:    npm run chain    (one terminal)
 *           npm run demo     (another)
 *
 * Testnet:  RATCHET_RPC=https://rpc.testnet.arc.io \
 *           RATCHET_PAYER_KEY=0x... RATCHET_PROVIDER_KEY=0x... npm run demo
 */
import { createPublicClient, createWalletClient, http, defineChain, decodeEventLog } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { createApi } from "./api.js";
import { RatchetClient } from "../src/client.js";
import { formatUsdc } from "../src/usdc.js";
import {
  VAULT_ABI,
  VAULT_BYTECODE,
  getChannel,
  claimAndClose,
  initiateClose,
  sweep,
} from "../src/vault.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CALLS = Number(process.env.RATCHET_CALLS ?? 1000);
const PRICE = process.env.RATCHET_PRICE ?? "0.001";
const SETTLE_AT = process.env.RATCHET_SETTLE_AT ?? "0.40";
const DEPOSIT = process.env.RATCHET_DEPOSIT ?? "2.00";
const RPC_URL = process.env.RATCHET_RPC ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? 4021);
const IS_LOCAL = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");

const MNEMONIC = "test test test test test test test test test test test junk";

const localChain = defineChain({
  id: 31337,
  name: "Ratchet Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const chain = IS_LOCAL ? localChain : arcTestnet;

const payerAccount = process.env.RATCHET_PAYER_KEY
  ? privateKeyToAccount(process.env.RATCHET_PAYER_KEY)
  : mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

const providerAccount = process.env.RATCHET_PROVIDER_KEY
  ? privateKeyToAccount(process.env.RATCHET_PROVIDER_KEY)
  : mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const payerWallet = createWalletClient({ account: payerAccount, chain, transport: http(RPC_URL) });
const providerWallet = createWalletClient({
  account: providerAccount,
  chain,
  transport: http(RPC_URL),
});

// ---------------------------------------------------------------------------
// Accounting, reconstructed from vault logs
// ---------------------------------------------------------------------------

/** Label a transaction by the set of vault events it emitted. */
function labelFor(events) {
  if (events.includes("Claimed") && events.includes("ChannelClosed")) return "claimAndClose";
  if (events.includes("ChannelClosed")) return "sweep";
  if (events.includes("ChannelOpened")) return "open channel";
  if (events.includes("Claimed")) return "settle voucher";
  if (events.includes("CloseInitiated")) return "initiate close";
  if (events.includes("ChannelToppedUp")) return "top up";
  return events[0] ?? "unknown";
}

/** Every transaction that touched the vault, in order, with real gas costs. */
async function vaultTransactions(vault, fromBlock) {
  const logs = await publicClient.getLogs({ address: vault, fromBlock, toBlock: "latest" });

  const byTx = new Map();
  for (const log of logs) {
    let eventName;
    try {
      ({ eventName } = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics }));
    } catch {
      continue;
    }
    const entry = byTx.get(log.transactionHash) ?? {
      hash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      events: [],
    };
    entry.events.push(eventName);
    byTx.set(log.transactionHash, entry);
  }

  const ordered = [...byTx.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? Number(a.logIndex - b.logIndex)
      : Number(a.blockNumber - b.blockNumber),
  );

  const out = [];
  for (const entry of ordered) {
    const receipt = await publicClient.getTransactionReceipt({ hash: entry.hash });
    out.push({
      label: labelFor(entry.events),
      gasUsed: receipt.gasUsed,
      fee: receipt.gasUsed * receipt.effectiveGasPrice,
      hash: entry.hash,
    });
  }
  return out;
}

const bar = (n = 74) => "─".repeat(n);
const isTty = Boolean(process.stdout.isTTY);

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${bar()}`);
  console.log(`  Ratchet — pay-per-call API metering on ${chain.name}`);
  console.log(bar());
  console.log(`  RPC       ${RPC_URL}`);
  console.log(`  payer     ${payerAccount.address}`);
  console.log(`  provider  ${providerAccount.address}`);
  console.log(`  price     $${PRICE} / call    calls: ${CALLS}    deposit: $${DEPOSIT}`);
  console.log(bar());

  const startBlock = await publicClient.getBlockNumber();
  let deployFee = 0n;

  // --- deploy (or reuse) the vault ----------------------------------------
  let vault = process.env.RATCHET_VAULT;
  if (!vault) {
    process.stdout.write("\n  deploying vault... ");
    const hash = await providerWallet.deployContract({
      abi: VAULT_ABI,
      bytecode: VAULT_BYTECODE,
      account: providerAccount,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    vault = receipt.contractAddress;
    deployFee = receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(vault);
  } else {
    console.log(`\n  using vault ${vault}`);
  }

  // --- stand up the paid API ----------------------------------------------
  const { app, ledger } = createApi({
    vault,
    provider: providerAccount.address,
    chain,
    publicClient,
    wallet: providerWallet,
    price: PRICE,
    settleAt: SETTLE_AT,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`  API listening on ${base}  (auto-settles every $${SETTLE_AT})`);

  try {
    const agent = new RatchetClient({
      wallet: payerWallet,
      publicClient,
      chain,
      budget: DEPOSIT,
      deposit: DEPOSIT,
    });

    console.log(`\n  ${CALLS} paid calls:\n`);
    const started = Date.now();
    let lastLogged = 0;

    for (let i = 0; i < CALLS; i++) {
      const res = await agent.fetch(`${base}/v1/sentiment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "the strong market rally looks great but volume is weak" }),
      });

      if (!res.ok) {
        throw new Error(`call ${i} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      await res.json();

      const pct = Math.floor(((i + 1) / CALLS) * 100);
      if (pct >= lastLogged + 10) {
        lastLogged = pct;
        const filled = Math.floor(pct / 2.5);
        const line =
          `    [${"█".repeat(filled)}${"░".repeat(40 - filled)}] ${String(pct).padStart(3)}%  ` +
          `spent $${formatUsdc(agent.stats.paid)}`;
        process.stdout.write(isTty ? `\r${line}` : `${line}\n`);
      }
    }

    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `\n\n  ${CALLS} calls in ${elapsed.toFixed(1)}s ` +
        `(${(CALLS / elapsed).toFixed(0)} calls/sec — each one a local signature, no round-trip to a chain)`,
    );

    // Let any in-flight background settlement land.
    await new Promise((r) => setTimeout(r, IS_LOCAL ? 1500 : 5000));

    // --- close out --------------------------------------------------------
    const state = ledger.all()[0];
    const channelId = state.channelId;
    const ch = await getChannel({ publicClient, vault, channelId });

    if (state.owed > ch.claimed) {
      process.stdout.write("  provider closes with the final voucher... ");
      await claimAndClose({
        wallet: providerWallet,
        publicClient,
        vault,
        voucher: state.latestVoucher,
      });
      console.log("done");
    } else if (IS_LOCAL) {
      process.stdout.write("  already fully settled — payer reclaims the remainder... ");
      await initiateClose({ wallet: payerWallet, publicClient, vault, channelId });
      await publicClient.request({
        method: "hardhat_mine",
        params: [`0x${(ch.challengeBlocks + 1n).toString(16)}`],
      });
      await sweep({ wallet: payerWallet, publicClient, vault, channelId });
      console.log("done");
    } else {
      console.log("  already fully settled; leaving the channel open for reuse.");
    }

    const txs = await vaultTransactions(vault, startBlock);
    report({ agent, vault, elapsed, txs, deployFee });
  } finally {
    server.close();
  }
}

function report({ agent, vault, elapsed, txs, deployFee }) {
  const revenue = agent.stats.paid;
  const totalFees = txs.reduce((a, t) => a + t.fee, 0n);

  console.log(`\n${bar()}`);
  console.log("  RESULT");
  console.log(bar());

  console.log(`\n  ${String(CALLS).padStart(6)} paid API calls`);
  console.log(`  ${String(txs.length).padStart(6)} on-chain transactions`);
  console.log(`  ${String(Math.round(CALLS / txs.length)).padStart(6)} calls per transaction\n`);

  console.log("  every transaction this took:");
  for (const t of txs) {
    console.log(
      `    ${t.label.padEnd(16)} ${String(t.gasUsed).padStart(8)} gas   $${formatUsdc(t.fee, 8)}`,
    );
  }

  const pct = revenue === 0n ? 0 : Number((totalFees * 1_000_000n) / revenue) / 10_000;

  console.log(`\n  revenue to provider      $${formatUsdc(revenue)}`);
  console.log(`  total on-chain cost      $${formatUsdc(totalFees, 8)}`);
  console.log(`  overhead                 ${pct.toFixed(3)}% of revenue`);
  console.log(`  cost per call            $${formatUsdc(totalFees / BigInt(CALLS), 10)}`);
  if (deployFee > 0n) {
    console.log(
      `  (vault deploy            $${formatUsdc(deployFee, 8)} once, shared by every user of the vault)`,
    );
  }

  // Baseline: what it would cost to put every single call on-chain, using the
  // measured cost of an actual settlement transaction.
  const settle = txs.find((t) => t.label === "settle voucher") ?? txs.find((t) => t.label === "claimAndClose");
  if (settle) {
    const naive = BigInt(CALLS) * settle.fee;
    const ratio = totalFees === 0n ? 0n : naive / totalFees;
    console.log(`\n  one on-chain tx per call would cost  $${formatUsdc(naive, 6)}`);
    console.log(`  ratchet costs                        $${formatUsdc(totalFees, 8)}`);
    console.log(`  cheaper by                           ${ratio}x`);
  }

  console.log(`\n  vault      ${vault}`);
  console.log(`  throughput ${(CALLS / elapsed).toFixed(0)} paid calls/sec`);
  console.log(`${bar()}\n`);
}

main().catch((err) => {
  console.error("\ndemo failed:", err);
  process.exit(1);
});
