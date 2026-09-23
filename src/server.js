/**
 * Provider-side metering middleware.
 *
 *   app.use("/v1", meter({ price: "0.001", provider, vault, chain, wallet, publicClient }))
 *
 * Unpaid requests get a 402 describing the terms. Paid requests carry a voucher
 * in `X-Ratchet-Voucher`; the middleware verifies it, books the revenue, and
 * lets the request through. Settlement happens in the background once enough
 * has accrued to be worth a transaction.
 */
import { decodeVoucher, recoverVoucherSigner } from "./voucher.js";
import { usdc, formatUsdc } from "./usdc.js";
import { getChannel, claim, MIN_CHALLENGE_BLOCKS } from "./vault.js";

export const VOUCHER_HEADER = "x-ratchet-voucher";
export const ACCEPT_HEADER = "x-ratchet-accept";

/**
 * In-memory ledger of what each channel owes us.
 *
 * Production deployments should swap this for something durable — losing it
 * means losing unsettled vouchers, which means losing revenue (never money
 * already on-chain, but the un-redeemed tail). The interface is deliberately
 * tiny so a Redis or Postgres implementation is a drop-in.
 */
export class MemoryLedger {
  #channels = new Map();

  get(channelId) {
    return this.#channels.get(channelId);
  }

  set(channelId, state) {
    this.#channels.set(channelId, state);
    return state;
  }

  all() {
    return [...this.#channels.values()];
  }
}

/**
 * @param {object} opts
 * @param {string|bigint} opts.price      Price per call, e.g. "0.001" (USDC) or a bigint in 18dp.
 * @param {`0x${string}`} opts.provider   Address that receives the funds.
 * @param {`0x${string}`} opts.vault      RatchetVault address.
 * @param {object} opts.chain             viem chain (arc / arcTestnet).
 * @param {object} opts.publicClient      viem public client.
 * @param {object} [opts.wallet]          Provider wallet; omit to disable auto-settlement.
 * @param {string|bigint} [opts.settleAt] Unsettled balance that triggers a claim. Default "0.25".
 * @param {bigint} [opts.minChallengeBlocks] Reject channels whose window is shorter.
 * @param {(req) => string|bigint} [opts.priceFor] Per-request pricing override.
 * @param {MemoryLedger} [opts.ledger]
 */
export function meter(opts) {
  const {
    provider,
    vault,
    chain,
    publicClient,
    wallet,
    priceFor,
    ledger = new MemoryLedger(),
    minChallengeBlocks = MIN_CHALLENGE_BLOCKS,
  } = opts;

  const basePrice = typeof opts.price === "bigint" ? opts.price : usdc(opts.price);
  const settleAt =
    opts.settleAt === undefined
      ? usdc("0.25")
      : typeof opts.settleAt === "bigint"
        ? opts.settleAt
        : usdc(opts.settleAt);

  const chainId = chain.id;
  const settling = new Set();
  /** Serialises voucher handling per channel so concurrent calls cannot race the ledger. */
  const queues = new Map();

  const terms = (extra = {}) => ({
    version: "1",
    chainId,
    vault,
    provider,
    currency: "USDC",
    decimals: 18,
    minChallengeBlocks: minChallengeBlocks.toString(),
    ...extra,
  });

  function reject(res, status, error, extra) {
    const body = { error, ratchet: terms(extra) };
    res.setHeader(ACCEPT_HEADER, Buffer.from(JSON.stringify(body.ratchet)).toString("base64"));
    res.status(status).json(body);
  }

  /** Load channel state from chain and validate it is one we will serve. */
  async function loadChannel(channelId) {
    const onChain = await getChannel({ publicClient, vault, channelId });

    if (onChain.provider.toLowerCase() !== provider.toLowerCase()) {
      throw new MeterError("channel_wrong_provider", "Channel does not pay this provider");
    }
    if (onChain.challengeBlocks < minChallengeBlocks) {
      throw new MeterError(
        "channel_challenge_too_short",
        `Challenge window ${onChain.challengeBlocks} is below the required ${minChallengeBlocks}`,
      );
    }
    if (onChain.closeAtBlock !== 0n) {
      throw new MeterError("channel_closing", "Channel is closing and cannot be metered against");
    }

    return ledger.set(channelId, {
      channelId,
      payer: onChain.payer,
      deposit: onChain.deposit,
      settled: onChain.claimed, // cumulative already redeemed on-chain
      owed: onChain.claimed, // cumulative we hold a voucher for
      latestVoucher: null,
      calls: 0,
    });
  }

  /** Refresh deposit/settled from chain — picks up top-ups and our own claims. */
  async function refresh(state) {
    const onChain = await getChannel({ publicClient, vault, channelId: state.channelId });
    state.deposit = onChain.deposit;
    state.settled = onChain.claimed;
    if (onChain.closeAtBlock !== 0n) {
      throw new MeterError("channel_closing", "Channel is closing and cannot be metered against");
    }
    return state;
  }

  async function settle(state) {
    if (!wallet || settling.has(state.channelId) || !state.latestVoucher) return;
    settling.add(state.channelId);
    try {
      await claim({ wallet, publicClient, vault, voucher: state.latestVoucher });
      state.settled = state.latestVoucher.cumulativeAmount;
    } catch (err) {
      // Settlement is retried on the next qualifying request. The voucher is
      // still valid, so nothing is lost by failing here.
      console.error(`[ratchet] settle failed for ${state.channelId}:`, err.shortMessage ?? err.message);
    } finally {
      settling.delete(state.channelId);
    }
  }

  /** Run `fn` with exclusive access to a channel's ledger entry. */
  function withChannelLock(channelId, fn) {
    const prev = queues.get(channelId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(
      channelId,
      next.catch(() => {}),
    );
    return next;
  }

  return async function ratchetMeter(req, res, next) {
    const price = priceFor ? toWei(priceFor(req)) : basePrice;
    const encoded = req.headers[VOUCHER_HEADER];

    if (!encoded) {
      return reject(res, 402, "payment_required", { price: price.toString() });
    }

    const voucher = decodeVoucher(Array.isArray(encoded) ? encoded[0] : encoded);
    if (!voucher) {
      return reject(res, 400, "malformed_voucher", { price: price.toString() });
    }

    try {
      await withChannelLock(voucher.channelId, async () => {
        let state = ledger.get(voucher.channelId);
        if (!state) state = await loadChannel(voucher.channelId);

        const signer = await recoverVoucherSigner({ voucher, vault, chainId });
        if (signer.toLowerCase() !== state.payer.toLowerCase()) {
          throw new MeterError("bad_signature", "Voucher was not signed by the channel payer");
        }

        const required = state.owed + price;

        if (voucher.cumulativeAmount < required) {
          // Either underpaying, or our view of the deposit is stale after a
          // top-up. Refreshing is cheap relative to serving work for free.
          throw new MeterError("insufficient_payment", `Voucher must authorise at least ${required}`, {
            price: price.toString(),
            channelId: voucher.channelId,
            requiredCumulative: required.toString(),
          });
        }

        if (voucher.cumulativeAmount > state.deposit) {
          await refresh(state);
          if (voucher.cumulativeAmount > state.deposit) {
            throw new MeterError("exceeds_deposit", "Voucher authorises more than the channel holds", {
              price: price.toString(),
              channelId: voucher.channelId,
              deposit: state.deposit.toString(),
            });
          }
        }

        state.owed = voucher.cumulativeAmount;
        state.latestVoucher = voucher;
        state.calls += 1;

        res.setHeader("x-ratchet-channel", state.channelId);
        res.setHeader("x-ratchet-charged", price.toString());
        res.setHeader("x-ratchet-cumulative", state.owed.toString());
        res.setHeader("x-ratchet-remaining", (state.deposit - state.owed).toString());

        req.ratchet = {
          channelId: state.channelId,
          payer: state.payer,
          charged: price,
          cumulative: state.owed,
          remaining: state.deposit - state.owed,
          calls: state.calls,
        };

        if (state.owed - state.settled >= settleAt) {
          // Fire and forget: the caller should not wait on a block.
          void settle(state);
        }
      });
    } catch (err) {
      if (err instanceof MeterError) {
        const status = err.code === "bad_signature" ? 403 : 402;
        return reject(res, status, err.code, err.extra ?? { price: price.toString() });
      }
      if (String(err?.message ?? "").includes("ChannelNotFound")) {
        return reject(res, 402, "unknown_channel", { price: price.toString() });
      }
      return next(err);
    }

    next();
  };
}

/** Settle every channel holding more than `min` unsettled. Call on shutdown. */
export async function settleAll({ ledger, wallet, publicClient, vault, min = 0n }) {
  const results = [];
  for (const state of ledger.all()) {
    if (!state.latestVoucher || state.owed - state.settled <= min) continue;
    try {
      const receipt = await claim({ wallet, publicClient, vault, voucher: state.latestVoucher });
      state.settled = state.latestVoucher.cumulativeAmount;
      results.push({ channelId: state.channelId, ok: true, receipt });
    } catch (err) {
      results.push({ channelId: state.channelId, ok: false, error: err });
    }
  }
  return results;
}

export class MeterError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const toWei = (v) => (typeof v === "bigint" ? v : usdc(v));

export { formatUsdc };
