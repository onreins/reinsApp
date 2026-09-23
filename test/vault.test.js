/**
 * RatchetVault behaviour, with an emphasis on the ways either side could cheat.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { encodePacked, keccak256, toHex } from "viem";

import {
  publicClient,
  walletFor,
  account,
  deployVault,
  mine,
  balanceOf,
  expectRevert,
  waitForNode,
  localChain,
} from "./helpers.js";
import { VAULT_ABI, MIN_CHALLENGE_BLOCKS } from "../src/vault.js";
import { openChannel, claim, claimAndClose, initiateClose, sweep, getChannel } from "../src/vault.js";
import { signVoucher } from "../src/voucher.js";
import { usdc } from "../src/usdc.js";

const DAY_BLOCKS = 172_800n; // ~1 day at 0.5s blocks

const payer = walletFor(1);
const provider = walletFor(2);
const stranger = walletFor(3);

const PAYER = account(1).address;
const PROVIDER = account(2).address;

before(async () => {
  await waitForNode();
});

/** Fresh vault + funded channel for each test. */
async function setup({ deposit = usdc("10"), challengeBlocks = DAY_BLOCKS } = {}) {
  const vault = await deployVault(0);
  const { channelId } = await openChannel({
    wallet: payer,
    publicClient,
    vault,
    provider: PROVIDER,
    deposit,
    challengeBlocks,
  });
  return { vault, channelId, deposit };
}

const voucherFor = (vault, channelId, amount, wallet = payer) =>
  signVoucher({
    wallet,
    vault,
    chainId: localChain.id,
    channelId,
    cumulativeAmount: amount,
  });

describe("opening channels", () => {
  test("records the deposit and emits a usable channel id", async () => {
    const { vault, channelId } = await setup({ deposit: usdc("5") });
    const ch = await getChannel({ publicClient, vault, channelId });

    assert.equal(ch.payer, PAYER);
    assert.equal(ch.provider, PROVIDER);
    assert.equal(ch.deposit, usdc("5"));
    assert.equal(ch.claimed, 0n);
    assert.equal(ch.closeAtBlock, 0n);
  });

  test("rejects a challenge window short enough to rug the provider", async () => {
    const vault = await deployVault(0);
    await expectRevert(
      openChannel({
        wallet: payer,
        publicClient,
        vault,
        provider: PROVIDER,
        deposit: usdc("1"),
        challengeBlocks: MIN_CHALLENGE_BLOCKS - 1n,
      }),
      "ChallengeTooShort",
    );
  });

  test("rejects a challenge window long enough to brick the channel", async () => {
    // block.number + challengeBlocks must fit uint64, or initiateClose reverts
    // forever under checked arithmetic and the payer strands their own funds.
    const vault = await deployVault(0);
    await expectRevert(
      openChannel({
        wallet: payer,
        publicClient,
        vault,
        provider: PROVIDER,
        deposit: usdc("1"),
        challengeBlocks: 2n ** 64n - 1n,
      }),
      "ChallengeTooLong",
    );
  });

  test("rejects an empty deposit", async () => {
    const vault = await deployVault(0);
    await expectRevert(
      openChannel({
        wallet: payer,
        publicClient,
        vault,
        provider: PROVIDER,
        deposit: 0n,
        challengeBlocks: DAY_BLOCKS,
      }),
      "EmptyDeposit",
    );
  });

  test("gives every channel a distinct id even with identical parameters", async () => {
    const vault = await deployVault(0);
    const args = {
      wallet: payer,
      publicClient,
      vault,
      provider: PROVIDER,
      deposit: usdc("1"),
      challengeBlocks: DAY_BLOCKS,
    };
    const a = await openChannel(args);
    const b = await openChannel(args);
    assert.notEqual(a.channelId, b.channelId);
  });
});

describe("redeeming vouchers", () => {
  test("pays the provider exactly the voucher amount", async () => {
    const { vault, channelId } = await setup();
    const before = await balanceOf(PROVIDER);

    const voucher = await voucherFor(vault, channelId, usdc("2.5"));
    // A relayer submits it, so the provider pays no gas and the delta is clean.
    await claim({ wallet: stranger, publicClient, vault, voucher });

    assert.equal((await balanceOf(PROVIDER)) - before, usdc("2.5"));
    const ch = await getChannel({ publicClient, vault, channelId });
    assert.equal(ch.claimed, usdc("2.5"));
  });

  test("pays only the delta when vouchers ratchet upward", async () => {
    const { vault, channelId } = await setup();
    const before = await balanceOf(PROVIDER);

    await claim({ wallet: stranger, publicClient, vault, voucher: await voucherFor(vault, channelId, usdc("1")) });
    await claim({ wallet: stranger, publicClient, vault, voucher: await voucherFor(vault, channelId, usdc("3")) });
    await claim({ wallet: stranger, publicClient, vault, voucher: await voucherFor(vault, channelId, usdc("4.25")) });

    // Three redemptions, but the payer only ever authorised 4.25 in total.
    assert.equal((await balanceOf(PROVIDER)) - before, usdc("4.25"));
  });

  test("refuses to replay a stale voucher", async () => {
    const { vault, channelId } = await setup();
    const stale = await voucherFor(vault, channelId, usdc("1"));
    const fresh = await voucherFor(vault, channelId, usdc("2"));

    await claim({ wallet: stranger, publicClient, vault, voucher: fresh });
    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: stale }),
      "VoucherNotAscending",
    );
  });

  test("refuses to pay out more than the channel holds", async () => {
    const { vault, channelId } = await setup({ deposit: usdc("1") });
    const overdraft = await voucherFor(vault, channelId, usdc("1.000000000000000001"));
    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: overdraft }),
      "ExceedsDeposit",
    );
  });

  test("refuses a voucher signed by anyone but the payer", async () => {
    const { vault, channelId } = await setup();
    const forged = await voucherFor(vault, channelId, usdc("1"), stranger);
    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: forged }),
      "BadSignature",
    );
  });

  test("refuses a voucher minted for a different channel", async () => {
    const { vault, channelId } = await setup();
    const { channelId: other } = await openChannel({
      wallet: payer,
      publicClient,
      vault,
      provider: PROVIDER,
      deposit: usdc("10"),
      challengeBlocks: DAY_BLOCKS,
    });

    const voucher = await voucherFor(vault, other, usdc("1"));
    // Same signature, pointed at the wrong channel.
    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: { ...voucher, channelId } }),
      "BadSignature",
    );
  });

  test("refuses a voucher minted for a different vault deployment", async () => {
    const { vault, channelId } = await setup();
    const otherVault = await deployVault(0);

    // The EIP-712 domain binds to verifyingContract, so this must not verify.
    const voucher = await voucherFor(otherVault, channelId, usdc("1"));
    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher }),
      "BadSignature",
    );
  });

  test("rejects a malleated signature", async () => {
    const { vault, channelId } = await setup();
    const voucher = await voucherFor(vault, channelId, usdc("1"));

    // Flip s to n - s and v to the opposite parity: a classic malleable twin
    // that recovers to the same address on a naive implementation.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const raw = voucher.signature.slice(2);
    const r = raw.slice(0, 64);
    const s = BigInt(`0x${raw.slice(64, 128)}`);
    const v = parseInt(raw.slice(128, 130), 16);

    const malleated = `0x${r}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27)
      .toString(16)
      .padStart(2, "0")}`;

    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: { ...voucher, signature: malleated } }),
      "BadSignature",
    );
  });

  test("rejects a voucher against a channel that no longer exists", async () => {
    const { vault, channelId } = await setup();
    const final = await voucherFor(vault, channelId, usdc("1"));
    await claimAndClose({ wallet: provider, publicClient, vault, voucher: final });

    const replay = await voucherFor(vault, channelId, usdc("2"));
    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: replay }),
      "ChannelNotFound",
    );
  });
});

describe("closing", () => {
  test("payer cannot sweep before the challenge window elapses", async () => {
    const { vault, channelId } = await setup();
    await initiateClose({ wallet: payer, publicClient, vault, channelId });

    await expectRevert(
      sweep({ wallet: payer, publicClient, vault, channelId }),
      "ChallengeNotElapsed",
    );
  });

  test("provider can still redeem during the challenge window", async () => {
    const { vault, channelId } = await setup();
    const before = await balanceOf(PROVIDER);

    await initiateClose({ wallet: payer, publicClient, vault, channelId });
    await mine(DAY_BLOCKS - 10n);

    await claim({
      wallet: stranger,
      publicClient,
      vault,
      voucher: await voucherFor(vault, channelId, usdc("3")),
    });
    assert.equal((await balanceOf(PROVIDER)) - before, usdc("3"));
  });

  test("payer reclaims only the unspent remainder after the window", async () => {
    const { vault, channelId } = await setup({ deposit: usdc("10") });

    await claim({
      wallet: stranger,
      publicClient,
      vault,
      voucher: await voucherFor(vault, channelId, usdc("4")),
    });

    await initiateClose({ wallet: payer, publicClient, vault, channelId });
    await mine(DAY_BLOCKS + 1n);

    const before = await balanceOf(PAYER);
    // Submitted by a stranger so gas does not muddy the payer's delta.
    await sweep({ wallet: stranger, publicClient, vault, channelId });

    assert.equal((await balanceOf(PAYER)) - before, usdc("6"));
    await expectRevert(getChannel({ publicClient, vault, channelId }), "ChannelNotFound");
  });

  test("only the payer may start a close", async () => {
    const { vault, channelId } = await setup();
    await expectRevert(
      initiateClose({ wallet: stranger, publicClient, vault, channelId }),
      "NotPayer",
    );
  });

  test("claimAndClose settles both sides in one transaction", async () => {
    const { vault, channelId } = await setup({ deposit: usdc("10") });
    const payerBefore = await balanceOf(PAYER);
    const providerBefore = await balanceOf(PROVIDER);

    const voucher = await voucherFor(vault, channelId, usdc("7.5"));
    // The provider submits it — see the theft test below for why that matters.
    await claimAndClose({ wallet: provider, publicClient, vault, voucher });

    // The provider pays gas here, so compare against the payer's clean delta
    // and assert the provider simply came out ahead.
    assert.ok((await balanceOf(PROVIDER)) > providerBefore);
    assert.equal((await balanceOf(PAYER)) - payerBefore, usdc("2.5"));
    await expectRevert(getChannel({ publicClient, vault, channelId }), "ChannelNotFound");
  });

  test("a payer cannot close the channel and destroy an unsettled voucher", async () => {
    // Regression for a real hole: claimAndClose had no caller check, and the
    // payer is the only party who signs vouchers. So a payer could mint a
    // minimal ascending voucher, close the channel themselves, and make the
    // provider's held voucher for delivered work permanently unredeemable —
    // paying a single wei for it. Measured at $93 destroyed before the fix.
    const { vault, channelId } = await setup({ deposit: usdc("100") });

    await claim({
      wallet: provider,
      publicClient,
      vault,
      voucher: await voucherFor(vault, channelId, usdc("2")),
    });

    // The provider is holding this, unsettled, while batching.
    const earned = await voucherFor(vault, channelId, usdc("95"));

    const rug = await voucherFor(vault, channelId, usdc("2") + 1n);
    await expectRevert(
      claimAndClose({ wallet: payer, publicClient, vault, voucher: rug }),
      "NotProvider",
    );
    await expectRevert(
      claimAndClose({ wallet: stranger, publicClient, vault, voucher: rug }),
      "NotProvider",
    );

    // The channel survived, so the earned voucher is still good.
    const before = await balanceOf(PROVIDER);
    await claim({ wallet: stranger, publicClient, vault, voucher: earned });
    assert.equal((await balanceOf(PROVIDER)) - before, usdc("93"));
  });

  test("a closing channel cannot be topped up", async () => {
    const { vault, channelId } = await setup();
    await initiateClose({ wallet: payer, publicClient, vault, channelId });

    await expectRevert(
      payer.writeContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "topUp",
        args: [channelId],
        value: usdc("1"),
        chain: localChain,
        account: payer.account,
      }),
      "AlreadyClosing",
    );
  });

  test("the vault never holds more than the sum of open channels", async () => {
    const { vault, channelId, deposit } = await setup({ deposit: usdc("10") });
    assert.equal(await balanceOf(vault), deposit);

    await claim({
      wallet: stranger,
      publicClient,
      vault,
      voucher: await voucherFor(vault, channelId, usdc("6")),
    });
    assert.equal(await balanceOf(vault), usdc("4"));

    await initiateClose({ wallet: payer, publicClient, vault, channelId });
    await mine(DAY_BLOCKS + 1n);
    await sweep({ wallet: stranger, publicClient, vault, channelId });

    assert.equal(await balanceOf(vault), 0n);
  });
});

describe("topping up", () => {
  test("raises the ceiling an open channel can meter against", async () => {
    const { vault, channelId } = await setup({ deposit: usdc("1") });

    await expectRevert(
      claim({ wallet: stranger, publicClient, vault, voucher: await voucherFor(vault, channelId, usdc("2")) }),
      "ExceedsDeposit",
    );

    await payer.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "topUp",
      args: [channelId],
      value: usdc("5"),
      chain: localChain,
      account: payer.account,
    });

    const before = await balanceOf(PROVIDER);
    await claim({ wallet: stranger, publicClient, vault, voucher: await voucherFor(vault, channelId, usdc("2")) });
    assert.equal((await balanceOf(PROVIDER)) - before, usdc("2"));
  });
});

describe("EIP-712 agreement", () => {
  test("the off-chain digest matches the contract's", async () => {
    const { vault, channelId } = await setup();
    const amount = usdc("1.234567");

    const onChain = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "voucherHash",
      args: [channelId, amount],
    });

    // Rebuild the digest the way viem signs it, from the contract's own domain.
    const domainSeparator = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "domainSeparator",
    });
    const typeHash = keccak256(toHex("Voucher(bytes32 channelId,uint256 cumulativeAmount)"));
    const structHash = keccak256(
      encodePacked(["bytes32", "bytes32", "uint256"], [typeHash, channelId, amount]),
    );
    const digest = keccak256(
      encodePacked(["bytes2", "bytes32", "bytes32"], ["0x1901", domainSeparator, structHash]),
    );

    assert.equal(onChain, digest);
  });
});
