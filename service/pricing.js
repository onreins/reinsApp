/**
 * What a run costs.
 *
 * Priced like serverless compute: a small fixed fee that covers starting the
 * sandbox, plus time actually spent. Billing is rounded up to a tick so the
 * arithmetic stays honest at the sub-cent scale we operate at.
 *
 * The caller is quoted a *ceiling* before the run (base + their requested
 * timeout) and charged the real figure afterwards. Asking for a generous
 * timeout therefore costs nothing if the code finishes quickly — it only
 * reserves headroom.
 */
import { usdc, formatUsdc } from "../src/usdc.js";

export const PRICING = {
  /** Charged on every run, successful or not. Covers sandbox startup. */
  base: usdc("0.0002"),
  /** Charged per tick of wall-clock time. */
  perTick: usdc("0.00005"),
  tickMs: 100,
  /** Longest run we will accept, and therefore the worst case we quote. */
  maxTimeoutMs: 30_000,
  defaultTimeoutMs: 10_000,
};

const ticks = (ms) => BigInt(Math.max(0, Math.ceil(ms / PRICING.tickMs)));

/** Actual cost of a completed run. */
export function costOf(durationMs) {
  return PRICING.base + ticks(durationMs) * PRICING.perTick;
}

/** Worst-case cost of a run allowed `timeoutMs`, which is what we reserve. */
export function ceilingFor(timeoutMs) {
  return costOf(clampTimeout(timeoutMs));
}

export function clampTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return PRICING.defaultTimeoutMs;
  return Math.min(Math.ceil(n), PRICING.maxTimeoutMs);
}

/** Human-readable rate card, served at /pricing. */
export function rateCard() {
  return {
    currency: "USDC",
    base: formatUsdc(PRICING.base),
    perSecond: formatUsdc(PRICING.perTick * BigInt(1000 / PRICING.tickMs)),
    billingIncrementMs: PRICING.tickMs,
    maxTimeoutMs: PRICING.maxTimeoutMs,
    examples: [
      { run: "50ms (a quick calculation)", cost: formatUsdc(costOf(50)) },
      { run: "250ms (typical script)", cost: formatUsdc(costOf(250)) },
      { run: "2s (heavier work)", cost: formatUsdc(costOf(2000)) },
      { run: "10s (timed out)", cost: formatUsdc(costOf(10_000)) },
    ],
    note: "You are quoted the worst case for your timeout and charged for the time actually used.",
  };
}
