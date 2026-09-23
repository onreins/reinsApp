/**
 * Typed wrapper around the RatchetVault contract.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const artifact = JSON.parse(readFileSync(join(root, "build", "RatchetVault.json"), "utf8"));

export const VAULT_ABI = artifact.abi;
export const VAULT_BYTECODE = artifact.bytecode;

/**
 * Measured on Arc testnet: ~0.5s per block. Arc block timestamps are only
 * non-decreasing, so the contract counts deadlines in blocks and this is the
 * conversion you reason about off-chain.
 */
export const BLOCK_SECONDS = 0.5;

/** Convert a human duration to a block count. */
export const blocksFor = ({ hours = 0, days = 0 }) =>
  BigInt(Math.ceil(((hours + days * 24) * 3600) / BLOCK_SECONDS));

/** Contract floor: MIN_CHALLENGE_BLOCKS, about one hour. */
export const MIN_CHALLENGE_BLOCKS = 7_500n;

/** A sane default challenge window: one day. */
export const DEFAULT_CHALLENGE_BLOCKS = blocksFor({ days: 1 });

/**
 * Open and fund a channel. Returns the channel id pulled from the emitted event
 * (the return value of a state-changing call is not available to the caller).
 */
export async function openChannel({
  wallet,
  publicClient,
  vault,
  provider,
  deposit,
  challengeBlocks = DEFAULT_CHALLENGE_BLOCKS,
}) {
  const hash = await wallet.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "open",
    args: [provider, challengeBlocks],
    value: deposit,
    chain: wallet.chain,
    account: wallet.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "ChannelOpened") {
        return { channelId: ev.args.channelId, receipt };
      }
    } catch {
      // not one of ours
    }
  }
  throw new Error("open() succeeded but no ChannelOpened event was found");
}

/** Redeem a voucher, leaving the channel open for continued metering. */
export async function claim({ wallet, publicClient, vault, voucher }) {
  const hash = await wallet.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "claim",
    args: [voucher.channelId, voucher.cumulativeAmount, voucher.signature],
    chain: wallet.chain,
    account: wallet.account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

/** Redeem a final voucher, refund the payer, and close the channel. */
export async function claimAndClose({ wallet, publicClient, vault, voucher }) {
  const hash = await wallet.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "claimAndClose",
    args: [voucher.channelId, voucher.cumulativeAmount, voucher.signature],
    chain: wallet.chain,
    account: wallet.account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

/** Payer-side unilateral exit: start the challenge window. */
export async function initiateClose({ wallet, publicClient, vault, channelId }) {
  const hash = await wallet.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "initiateClose",
    args: [channelId],
    chain: wallet.chain,
    account: wallet.account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

/** Reclaim the remainder once the challenge window has elapsed. */
export async function sweep({ wallet, publicClient, vault, channelId }) {
  const hash = await wallet.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "sweep",
    args: [channelId],
    chain: wallet.chain,
    account: wallet.account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

export async function getChannel({ publicClient, vault, channelId }) {
  return publicClient.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "getChannel",
    args: [channelId],
  });
}

export async function remaining({ publicClient, vault, channelId }) {
  return publicClient.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "remaining",
    args: [channelId],
  });
}
