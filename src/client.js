/**
 * Payer-side client.
 *
 * Wraps `fetch`. On a 402 it reads the provider's terms, opens a channel if it
 * does not have one, signs a voucher, and retries. After that every call is a
 * local signature — no network round-trip to a chain, no confirmation wait.
 *
 *   const pay = new RatchetClient({ wallet, publicClient, chain, budget: "1.00" })
 *   const res = await pay.fetch("https://api.example.com/v1/infer", { method: "POST", body })
 */
import { signVoucher } from "./voucher.js";
import { encodeVoucher } from "./voucher.js";
import { usdc, formatUsdc } from "./usdc.js";
import { openChannel, getChannel, DEFAULT_CHALLENGE_BLOCKS } from "./vault.js";
import { VOUCHER_HEADER } from "./server.js";

export class RatchetClient {
  /**
   * @param {object} opts
   * @param {object} opts.wallet        Payer wallet client.
   * @param {object} opts.publicClient
   * @param {object} opts.chain
   * @param {string|bigint} [opts.budget]   Max total spend per provider. Default "1.00".
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
    this.budget = typeof budget === "bigint" ? budget : usdc(budget);
    this.deposit = deposit === undefined ? this.budget : typeof deposit === "bigint" ? deposit : usdc(deposit);
    this.challengeBlocks = challengeBlocks;
    this.fetchImpl = fetchImpl;

    /** "vault:provider" -> channel session */
    this.sessions = new Map();
    /** origin -> cached 402 terms, so repeat calls skip the challenge */
    this.originTerms = new Map();
    this.stats = { calls: 0, paid: 0n, channelsOpened: 0, retries: 0 };
  }

  /** Session key: one channel per (vault, provider) pair. */
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
      cumulative: 0n,
    };
    this.sessions.set(key, session);
    return session;
  }

  async #voucherFor(session, amount) {
    const next = session.cumulative + amount;

    if (next > this.budget) {
      throw new RatchetClientError(
        `Budget exhausted: ${formatUsdc(next)} would exceed the ${formatUsdc(this.budget)} cap`,
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

    session.cumulative = next;
    this.stats.paid += amount;
    return voucher;
  }

  /**
   * fetch(), paying automatically when the server asks.
   *
   * The first call to an origin costs a 402 round-trip while we learn its terms.
   * Every call after that pays up front from cache, so the steady state is one
   * request per call with a local signature attached. Retries at most once, so a
   * misbehaving server cannot loop us.
   */
  async fetch(url, init = {}) {
    const attempt = async (voucher) => {
      const headers = new Headers(init.headers ?? {});
      if (voucher) headers.set(VOUCHER_HEADER, encodeVoucher(voucher));
      return this.fetchImpl(url, { ...init, headers });
    };

    const origin = new URL(url).origin;
    const cached = this.originTerms.get(origin);

    let res;
    if (cached && this.sessions.has(this.#key(cached))) {
      // We know the price and hold a channel: pay up front, skip the 402.
      const session = await this.#session(cached);
      const voucher = await this.#voucherFor(session, BigInt(cached.price ?? "0"));
      res = await attempt(voucher);
    } else {
      res = await attempt(undefined);
    }

    if (res.status !== 402) {
      this.stats.calls += 1;
      return res;
    }

    const terms = await this.#terms(res);
    this.originTerms.set(origin, terms);
    const session = await this.#session(terms);
    const price = BigInt(terms.price ?? "0");

    // The server is authoritative about what it expects next; honour its figure
    // when it is ahead of ours (e.g. after a restart on our side).
    let amount = price;
    if (terms.requiredCumulative) {
      const required = BigInt(terms.requiredCumulative);
      if (required > session.cumulative) amount = required - session.cumulative;
    }

    const voucher = await this.#voucherFor(session, amount);
    this.stats.retries += 1;
    res = await attempt(voucher);
    this.stats.calls += 1;

    if (res.status === 402) {
      const detail = await res.text().catch(() => "");
      throw new RatchetClientError(`Provider still refused payment: ${detail.slice(0, 300)}`);
    }
    return res;
  }

  /** Make a paid call against a session we already hold, without a 402 round-trip. */
  async pay(url, init = {}, { vault, provider, price }) {
    const session = await this.#session({
      vault,
      provider,
      chainId: this.chain.id,
      minChallengeBlocks: "0",
    });
    const voucher = await this.#voucherFor(session, typeof price === "bigint" ? price : usdc(price));
    const headers = new Headers(init.headers ?? {});
    headers.set(VOUCHER_HEADER, encodeVoucher(voucher));
    this.stats.calls += 1;
    return this.fetchImpl(url, { ...init, headers });
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
    if (!body?.ratchet) {
      throw new RatchetClientError("Server returned 402 without Ratchet terms");
    }
    return body.ratchet;
  }

  /** On-chain state of a session's channel. */
  async channelState(providerAddress) {
    const session = [...this.sessions.values()].find(
      (s) => s.provider.toLowerCase() === providerAddress.toLowerCase(),
    );
    if (!session) return null;
    return getChannel({
      publicClient: this.publicClient,
      vault: session.vault,
      channelId: session.channelId,
    });
  }

  summary() {
    return {
      ...this.stats,
      paidFormatted: `$${formatUsdc(this.stats.paid)}`,
      sessions: [...this.sessions.values()].map((s) => ({
        provider: s.provider,
        channelId: s.channelId,
        cumulative: s.cumulative,
        cumulativeFormatted: `$${formatUsdc(s.cumulative)}`,
      })),
    };
  }
}

export class RatchetClientError extends Error {}
