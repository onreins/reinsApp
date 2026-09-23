/**
 * Provider-side metering middleware.
 *
 *   app.use("/v1", meter({ price: "0.001", provider, vault, chain, wallet, publicClient }))
 *
 * Unpaid requests get a 402 describing the terms. Paid requests carry a voucher
 * in `X-Ratchet-Voucher`; the middleware verifies it, books the revenue, and
 * lets the request through. Settlement happens in the background once enough
 * has accrued to be worth a transaction.
 *
 * ## Variable-cost work
 *
 * For work whose cost is not known until it is done (running code, generating
 * tokens), the voucher authorises a *ceiling* and the handler reports what was
 * actually used:
 *
 *   meter({ price: "0.002", ... })          // ceiling per call
 *   app.post("/run", (req, res) => {
 *     const result = execute(req.body)
 *     req.ratchet.charge(costOf(result))    // <= the ceiling; the rest is released
 *     res.json(result)
 *   })
 *
 * The middleware reserves the ceiling before the handler runs and releases the
 * unused part afterwards, so concurrent calls can never over-commit a deposit.
 *
 * Settlement is the subtle part. A voucher says "you may take up to X in
 * total", and redeeming one takes *all* of X. Since a caller's newest voucher
 * authorises more than they have actually used, redeeming it would overcharge
 * them. So the provider settles with the newest voucher whose total is at or
 * below what has genuinely been booked — which lags real usage by roughly one
 * call, and is never a penny more than owed.
 */
import { decodeVoucher, recoverVoucherSigner } from "./voucher.js";
import { usdc, formatUsdc } from "./usdc.js";
import { getChannel, claim, MIN_CHALLENGE_BLOCKS } from "./vault.js";

export const VOUCHER_HEADER = "x-ratchet-voucher";
export const ACCEPT_HEADER = "x-ratchet-accept";

/** How many recent vouchers to retain while waiting for usage to catch up. */
const VOUCHER_RING = 64;

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
 * @param {string|bigint} opts.price      Price per call — a ceiling when the handler calls charge().
 * @param {`0x${string}`} opts.provider   Address that receives the funds.
 * @param {`0x${string}`} opts.vault      RatchetVault address.
 * @param {object} opts.chain             viem chain (arc / arcTestnet).
 * @param {object} opts.publicClient      viem public client.
 * @param {object} [opts.wallet]          Provider wallet; omit to disable auto-settlement.
 * @param {string|bigint} [opts.settleAt] Unsettled balance that triggers a claim. Default "0.25".
 * @param {bigint} [opts.minChallengeBlocks] Reject channels whose window is shorter.
 * @param {(req) => string|bigint} [opts.priceFor] Per-request ceiling override.
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

  const basePrice = toWei(opts.price);
  const settleAt = opts.settleAt === undefined ? usdc("0.25") : toWei(opts.settleAt);

  const chainId = chain.id;
  const settling = new Set();
  /** Serialises ledger mutation per channel so concurrent calls cannot race. */
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
    const ratchet = terms(extra);
    res.setHeader(ACCEPT_HEADER, Buffer.from(JSON.stringify(ratchet)).toString("base64"));
    res.status(status).json({ error, ratchet });
  }

  /** Load channel state from chain and validate it is one we will serve. */
  async function loadChannel(channelId) {
    const onChain = await getChannel({ publicClient, vault, channelId });
    assertServable(onChain);

    return ledger.set(channelId, {
      channelId,
      payer: onChain.payer,
      deposit: onChain.deposit,
      settled: onChain.claimed, // cumulative already redeemed on-chain
      owed: onChain.claimed, // cumulative genuinely used
      reserved: 0n, // in-flight ceilings not yet resolved
      vouchers: [], // recent vouchers, ascending
      settleable: null, // newest voucher with cumulative <= owed
      calls: 0,
    });
  }

  function assertServable(onChain) {
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
  }

  /** Refresh deposit/settled from chain — picks up top-ups and our own claims. */
  async function refresh(state) {
    const onChain = await getChannel({ publicClient, vault, channelId: state.channelId });
    assertServable(onChain);
    state.deposit = onChain.deposit;
    state.settled = onChain.claimed;
    return state;
  }

  /**
   * Promote the newest voucher we could redeem without overcharging, and drop
   * everything it supersedes.
   */
  function promote(state) {
    let best = state.settleable;
    for (const v of state.vouchers) {
      if (v.cumulativeAmount <= state.owed && (!best || v.cumulativeAmount > best.cumulativeAmount)) {
        best = v;
      }
    }
    state.settleable = best;
    state.vouchers = state.vouchers.filter(
      (v) => !best || v.cumulativeAmount > best.cumulativeAmount,
    );
    if (state.vouchers.length > VOUCHER_RING) {
      state.vouchers = state.vouchers.slice(-VOUCHER_RING);
    }
  }

  async function settle(state) {
    if (!wallet || settling.has(state.channelId) || !state.settleable) return;
    if (state.settleable.cumulativeAmount <= state.settled) return;

    settling.add(state.channelId);
    const voucher = state.settleable;
    try {
      await claim({ wallet, publicClient, vault, voucher });
      state.settled = voucher.cumulativeAmount;
    } catch (err) {
      // Retried on the next qualifying request. The voucher stays valid, so
      // failing here costs nothing but time.
      console.error(
        `[ratchet] settle failed for ${state.channelId}:`,
        err.shortMessage ?? err.message,
      );
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
    const ceiling = priceFor ? toWei(priceFor(req)) : basePrice;
    const encoded = req.headers[VOUCHER_HEADER];

    if (!encoded) return reject(res, 402, "payment_required", { price: ceiling.toString() });

    const voucher = decodeVoucher(Array.isArray(encoded) ? encoded[0] : encoded);
    if (!voucher) return reject(res, 400, "malformed_voucher", { price: ceiling.toString() });

    let booked = false;
    let state;

    try {
      await withChannelLock(voucher.channelId, async () => {
        state = ledger.get(voucher.channelId) ?? (await loadChannel(voucher.channelId));

        const signer = await recoverVoucherSigner({ voucher, vault, chainId });
        if (signer.toLowerCase() !== state.payer.toLowerCase()) {
          throw new MeterError("bad_signature", "Voucher was not signed by the channel payer");
        }

        // Committed = what we have used, plus what in-flight calls may still use.
        const committed = state.owed + state.reserved;
        const required = committed + ceiling;

        if (voucher.cumulativeAmount < required) {
          throw new MeterError(
            "insufficient_payment",
            `Voucher must authorise at least ${required}`,
            {
              price: ceiling.toString(),
              channelId: voucher.channelId,
              requiredCumulative: required.toString(),
              cumulative: state.owed.toString(),
            },
          );
        }

        if (voucher.cumulativeAmount > state.deposit) {
          await refresh(state); // could be a top-up we have not seen
          if (voucher.cumulativeAmount > state.deposit) {
            throw new MeterError(
              "exceeds_deposit",
              "Voucher authorises more than the channel holds",
              {
                price: ceiling.toString(),
                channelId: voucher.channelId,
                deposit: state.deposit.toString(),
              },
            );
          }
        }

        state.vouchers.push(voucher);
        state.reserved += ceiling;
        state.calls += 1;
      });
    } catch (err) {
      if (err instanceof MeterError) {
        return reject(res, err.code === "bad_signature" ? 403 : 402, err.code, err.extra ?? {
          price: ceiling.toString(),
        });
      }
      if (String(err?.message ?? "").includes("ChannelNotFound")) {
        return reject(res, 402, "unknown_channel", { price: ceiling.toString() });
      }
      return next(err);
    }

    /**
     * Move `amount` (clamped to the ceiling) from reserved to owed. Idempotent.
     *
     * Deliberately synchronous, and deliberately not behind the channel lock:
     * it contains no `await`, so the event loop already runs it atomically.
     * Making it async would let `res.json()` win the race and send the
     * provisional ceiling in the headers instead of the real charge.
     */
    const book = (amount) => {
      if (booked) return;
      booked = true;
      const actual = amount < 0n ? 0n : amount > ceiling ? ceiling : amount;
      state.reserved -= ceiling;
      state.owed += actual;
      promote(state);

      if (!res.headersSent) {
        res.setHeader("x-ratchet-charged", actual.toString());
        res.setHeader("x-ratchet-cumulative", state.owed.toString());
        res.setHeader("x-ratchet-remaining", (state.deposit - state.owed).toString());
      }
      if (state.owed - state.settled >= settleAt) void settle(state);
    };

    // Provisional headers, in case the handler streams a response before charging.
    res.setHeader("x-ratchet-channel", state.channelId);
    res.setHeader("x-ratchet-charged", ceiling.toString());
    res.setHeader("x-ratchet-cumulative", (state.owed + ceiling).toString());

    req.ratchet = {
      channelId: state.channelId,
      payer: state.payer,
      ceiling,
      cumulative: state.owed,
      remaining: state.deposit - state.owed - state.reserved,
      calls: state.calls,
      /** Report what this call actually cost. Omit to be charged the ceiling. */
      charge: (amount) => book(toWei(amount)),
    };

    // Fail closed: a handler that never reports usage is charged the full ceiling.
    res.on("finish", () => {
      if (!booked) book(ceiling);
    });

    next();
  };
}

/** Settle every channel holding more than `min` unsettled. Call on shutdown. */
export async function settleAll({ ledger, wallet, publicClient, vault, min = 0n }) {
  const results = [];
  for (const state of ledger.all()) {
    const voucher = state.settleable;
    if (!voucher || voucher.cumulativeAmount <= state.settled) continue;
    if (voucher.cumulativeAmount - state.settled <= min) continue;
    try {
      const receipt = await claim({ wallet, publicClient, vault, voucher });
      state.settled = voucher.cumulativeAmount;
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

function toWei(v) {
  return typeof v === "bigint" ? v : usdc(v);
}

export { formatUsdc };
