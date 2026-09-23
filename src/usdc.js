/**
 * USDC amount handling for Arc.
 *
 * Arc exposes one balance through two interfaces: native USDC with 18 decimals,
 * and the ERC-20 view of the same balance with 6. Ratchet records everything in
 * the 18-decimal native unit — rounding to 6 decimals first would silently
 * truncate sub-cent per-call prices, which is exactly the range we bill in.
 */
import { parseUnits, formatUnits } from "viem";

export const NATIVE_DECIMALS = 18;
export const ERC20_DECIMALS = 6;

/** Scale factor between the native and ERC-20 views of the same balance. */
export const NATIVE_PER_ERC20 = 10n ** BigInt(NATIVE_DECIMALS - ERC20_DECIMALS);

/**
 * Parse a human USDC amount into 18-decimal native units.
 * Accepts "0.001", 0.001, or "$0.001".
 */
export function usdc(amount) {
  const cleaned = String(amount).trim().replace(/^\$/, "").replace(/,/g, "");
  return parseUnits(cleaned, NATIVE_DECIMALS);
}

/** Format 18-decimal native units as a decimal string, trailing zeros trimmed. */
export function formatUsdc(value, maxDecimals = 6) {
  const full = formatUnits(value, NATIVE_DECIMALS);
  if (!full.includes(".")) return full;
  const [whole, frac] = full.split(".");
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** Format as a currency string, e.g. "$0.001". */
export function formatUsd(value, maxDecimals = 6) {
  return `$${formatUsdc(value, maxDecimals)}`;
}

/**
 * Convert native (18dp) to the ERC-20 (6dp) view.
 * Display only — never round-trip balances through this.
 */
export function toErc20Units(nativeValue) {
  return nativeValue / NATIVE_PER_ERC20;
}
