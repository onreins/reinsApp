/**
 * Payer-side client.
 *
 * Wraps `fetch`. On a 402 it reads the provider's terms, opens a channel if it
 * does not have one, signs a voucher, and retries. After that every call is a
 * local signature — no network round-trip to a chain, no confirmation wait.
 *
 *   const pay = new RatchetClient({ wallet, publicClient, chain, budget: "1.00" })
 *   const res = await pay.fetch("https://api.example.com/v1/run", { method: "POST", body })
 *
 * ## Paying for variable-cost work
 *
 * Each voucher authorises a *ceiling*, not a fixed price. The provider books
 * only what the call actually used and reports the running total back on
 * `x-ratchet-cumulative`. The client trusts that figure because it can only
 * ever be lower than what was authorised — understating it costs the provider
 * money — and because it is checkable on-chain at any time via `channelState()`.
 *
 * Without this resync the client would keep signing against its own optimistic
 * ceilings and burn through a deposit far faster than it was actually spending.
 */
import { signVoucher, encodeVoucher } from "./voucher.js";
import { usdc, formatUsdc } from "./usdc.js";
import { openChannel, getChannel, DEFAULT_CHALLENGE_BLOCKS } from "./vault.js";
import { VOUCHER_HEADER } from "./server.js";

export class RatchetClient {
  /**
   * @param {object} opts
   * @param {object} opts.wallet        Payer wallet client.
   * @param {object} opts.publicClient
   * @param {object} opts.chain
   * @param {string|bigint} [opts.budget]   Max total spend. Default "1.00".
   * @param {string|bigint} [opts.deposit]  Channel size when opening. Defaults to the budget.
   * @param {bigint} [opts.challengeBlocks]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({
    wallet,
    publicClient,
    chain,
    budget = "1.00",
    deposit,
    challengeBlocks = DEFAULT_CHALLENGE_BLOCKS,
    fetchImpl = globalThis.fetch,
  }) {
    this.wallet = wallet;
    this.publicClient = publicClient;
    this.chain = chain;
    this.budget = toWei(budget);
    this.deposit = deposit === undefined ? this.budget : toWei(deposit);
    this.challengeBlocks = challengeBlocks;
    this.fetchImpl = fetchImpl;

    /** "vault:provider" -> channel session */
    this.sessions = new Map();
    /** origin -> cached 402 terms, so repeat calls skip the challenge */
    this.originTerms = new Map();

    this.stats = { calls: 0, authorised: 0n, spent: 0n, channelsOpened: 0, negotiations: 0 };
  }

  #key(terms) {
    return `${terms.vault.toLowerCase()}:${terms.provider.toLowerCase()}`;
  }

  async #session(terms) {
    const key = this.#key(terms);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    if (Number(terms.chainId) !== this.chain.id) {
      throw new RatchetClientError(
        `Provider wants chain ${terms.chainId}, client is on ${this.chain.id}`,
      );
    }

    const minChallenge = BigInt(terms.minChallengeBlocks ?? 0);
    const challengeBlocks =
      this.challengeBlocks < minChallenge ? minChallenge : this.challengeBlocks;

    const { channelId } = await openChannel({
      wallet: this.wallet,
      publicClient: this.publicClient,
      vault: terms.vault,
      provider: terms.provider,
      deposit: this.deposit,
      challengeBlocks,
    });

    this.stats.channelsOpened += 1;

    const session = {
      key,
      vault: terms.vault,
      provider: terms.provider,
      chainId: Number(terms.chainId),
      channelId,
      deposit: this.deposit,
      booked: 0n, // what the provider says we actually owe
      signed: 0n, // highest cumulative we have authorised
    };
    this.sessions.set(key, session);
    return session;
  }

  /** Sign an authorisation for `booked + ceiling`. */
  async #voucherFor(session, ceiling, floor = 0n) {
    let next = session.booked + ceiling;
    if (next < floor) next = floor; // the provider asked for more headroom

    if (next > this.budget) {
      throw new RatchetClientError(
        `Budget exhausted: authorising ${formatUsdc(next)} would exceed the ${formatUsdc(this.budget)} cap ` +
          `(actually spent so far: ${formatUsdc(session.booked)})`,
      );
    }
    if (next > session.deposit) {
      throw new RatchetClientError(
        `Channel deposit exhausted: ${formatUsdc(next)} exceeds the ${formatUsdc(session.deposit)} deposit. Top up to continue.`,
      );
    }

    const voucher = await signVoucher({
      wallet: this.wallet,
      vault: session.vault,
      chainId: session.chainId,
      channelId: session.channelId,
      cumulativeAmount: next,
    });

    session.signed = next;
    return voucher;
  }

  /** Adopt the provider's figure for what we actually owe. */
  #resync(session, res) {
    const reported = res.headers.get("x-ratchet-cumulative");
    if (reported === null) return;
    try {
      const value = BigInt(reported);
      // Only ever move forward, and never past what we authorised.
      if (value >= session.booked && value <= session.signed) {
        this.stats.spent += value - session.booked;
        session.booked = value;
      }
    } catch {
      // Unparseable header: keep our own view rather than trusting garbage.
    }
  }

  /**
   * fetch(), paying automatically when the server asks.
   *
   * The first call to an origin costs a 402 round-trip while the client learns
   * the terms and opens a channel; every call after that pays up front from
   * cache. Retries at most once, so a misbehaving server cannot loop us.
   */
  async fetch(url, init = {}) {
    const attempt = (voucher) => {
      const headers = new Headers(init.headers ?? {});
      if (voucher) headers.set(VOUCHER_HEADER, encodeVoucher(voucher));
      return this.fetchImpl(url, { ...init, headers });
    };

    const origin = new URL(url).origin;
    const cached = this.originTerms.get(origin);
    let session = cached ? this.sessions.get(this.#key(cached)) : undefined;

    let res;
    if (cached && session) {
      const voucher = await this.#voucherFor(session, BigInt(cached.price ?? "0"));
      this.stats.authorised = session.signed;
      res = await attempt(voucher);
    } else {
      res = await attempt(undefined);
    }

    if (res.status !== 402) {
      if (session) this.#resync(session, res);
      this.stats.calls += 1;
      return res;
    }

    // Negotiate: learn the terms, open a channel if needed, pay, retry once.
    const terms = await this.#terms(res);
    this.originTerms.set(origin, terms);
    this.stats.negotiations += 1;

    session = await this.#session(terms);

    // The provider is authoritative about the headroom it needs.
    if (terms.cumulative !== undefined) {
      const theirView = BigInt(terms.cumulative);
      if (theirView > session.booked) {
        this.stats.spent += theirView - session.booked;
        session.booked = theirView;
      }
    }

    const ceiling = BigInt(terms.price ?? "0");
    const floor = terms.requiredCumulative ? BigInt(terms.requiredCumulative) : 0n;

    const voucher = await this.#voucherFor(session, ceiling, floor);
    this.stats.authorised = session.signed;

    res = await attempt(voucher);
    this.stats.calls += 1;

    if (res.status === 402) {
      const detail = await res.text().catch(() => "");
      throw new RatchetClientError(`Provider still refused payment: ${detail.slice(0, 300)}`);
    }

    this.#resync(session, res);
    return res;
  }

  async #terms(res) {
    const header = res.headers.get("x-ratchet-accept");
    if (header) {
      try {
        return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        // fall through to the body
      }
    }
    const body = await res.json().catch(() => null);
    if (!body?.ratchet) throw new RatchetClientError("Server returned 402 without Ratchet terms");
    return body.ratchet;
  }

  /** On-chain state of a session's channel — the check on everything above. */
  async channelState(providerAddress) {
    const session = [...this.sessions.values()].find(
      (s) => !providerAddress || s.provider.toLowerCase() === providerAddress.toLowerCase(),
    );
    if (!session) return null;
    return getChannel({
      publicClient: this.publicClient,
      vault: session.vault,
      channelId: session.channelId,
    });
  }

  summary() {
    const spent = [...this.sessions.values()].reduce((a, s) => a + s.booked, 0n);
    const authorised = [...this.sessions.values()].reduce((a, s) => a + s.signed, 0n);
    return {
      calls: this.stats.calls,
      channelsOpened: this.stats.channelsOpened,
      negotiations: this.stats.negotiations,
      spent,
      authorised,
      spentFormatted: `$${formatUsdc(spent)}`,
      authorisedFormatted: `$${formatUsdc(authorised)}`,
      averagePerCall: this.stats.calls ? spent / BigInt(this.stats.calls) : 0n,
      sessions: [...this.sessions.values()].map((s) => ({
        provider: s.provider,
        channelId: s.channelId,
        spent: s.booked,
        authorised: s.signed,
      })),
    };
  }
}

const toWei = (v) => (typeof v === "bigint" ? v : usdc(v));

export class RatchetClientError extends Error {}
