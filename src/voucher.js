/**
 * EIP-712 vouchers.
 *
 * A voucher says: "the payer authorises the provider to have pulled up to
 * `cumulativeAmount` in total from `channelId`." It is cumulative, not
 * incremental, which is the whole trick — the provider only ever has to keep
 * the highest one, and a lost or reordered voucher costs nothing.
 *
 * The EIP-712 domain binds every voucher to one chain id and one vault address,
 * so a signature is meaningless anywhere else. Channel ids are minted from a
 * counter that never resets, so a voucher from a closed channel can never be
 * replayed against a later one.
 */
import { verifyTypedData, recoverTypedDataAddress } from "viem";

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
};

/** Build the EIP-712 domain for a vault deployment. Must match RatchetVault.domainSeparator(). */
export function voucherDomain({ chainId, vault }) {
  return { name: "Ratchet", version: "1", chainId, verifyingContract: vault };
}

/**
 * Sign a voucher.
 * @param {object} p
 * @param {import('viem').WalletClient} p.wallet Payer wallet.
 * @param {`0x${string}`} p.vault   Vault address.
 * @param {number} p.chainId
 * @param {`0x${string}`} p.channelId
 * @param {bigint} p.cumulativeAmount Total authorised so far, in 18-dec USDC.
 * @returns {Promise<import('./types.js').Voucher>}
 */
export async function signVoucher({ wallet, vault, chainId, channelId, cumulativeAmount }) {
  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain: voucherDomain({ chainId, vault }),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { channelId, cumulativeAmount },
  });
  return { channelId, cumulativeAmount, signature };
}

/** Verify a voucher was signed by `payer`. */
export async function verifyVoucher({ voucher, payer, vault, chainId }) {
  return verifyTypedData({
    address: payer,
    domain: voucherDomain({ chainId, vault }),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { channelId: voucher.channelId, cumulativeAmount: voucher.cumulativeAmount },
    signature: voucher.signature,
  });
}

/** Recover the signer of a voucher without knowing the payer up front. */
export async function recoverVoucherSigner({ voucher, vault, chainId }) {
  return recoverTypedDataAddress({
    domain: voucherDomain({ chainId, vault }),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { channelId: voucher.channelId, cumulativeAmount: voucher.cumulativeAmount },
    signature: voucher.signature,
  });
}

/** Serialise a voucher for an HTTP header (bigints are not JSON-safe). */
export function encodeVoucher(voucher) {
  return Buffer.from(
    JSON.stringify({
      channelId: voucher.channelId,
      cumulativeAmount: voucher.cumulativeAmount.toString(),
      signature: voucher.signature,
    }),
  ).toString("base64");
}

/** Parse a voucher from an HTTP header. Returns null on anything malformed. */
export function decodeVoucher(encoded) {
  try {
    const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (
      typeof raw.channelId !== "string" ||
      typeof raw.cumulativeAmount !== "string" ||
      typeof raw.signature !== "string"
    ) {
      return null;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw.channelId)) return null;
    if (!/^0x[0-9a-fA-F]{130}$/.test(raw.signature)) return null;
    if (!/^\d+$/.test(raw.cumulativeAmount)) return null;

    return {
      channelId: raw.channelId,
      cumulativeAmount: BigInt(raw.cumulativeAmount),
      signature: raw.signature,
    };
  } catch {
    return null;
  }
}
