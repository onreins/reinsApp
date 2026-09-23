/**
 * Metering middleware: the places a caller could get work without paying for it.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  publicClient,
  walletFor,
  account,
  deployVault,
  waitForNode,
  localChain,
} from "./helpers.js";
import { meter, MemoryLedger, VOUCHER_HEADER } from "../src/server.js";
import { signVoucher, encodeVoucher } from "../src/voucher.js";
import { openChannel } from "../src/vault.js";
import { usdc } from "../src/usdc.js";
import { RatchetClient } from "../src/client.js";

const DAY_BLOCKS = 172_800n;
const PRICE = usdc("0.001");

const payer = walletFor(1);
const providerWallet = walletFor(2);
const stranger = walletFor(3);
const PROVIDER = account(2).address;

let vault;
let channelId;
let server;
let baseUrl;
let ledger;

before(async () => {
  await waitForNode();
  vault = await deployVault(0);

  ({ channelId } = await openChannel({
    wallet: payer,
    publicClient,
    vault,
    provider: PROVIDER,
    deposit: usdc("1"),
    challengeBlocks: DAY_BLOCKS,
  }));

  ledger = new MemoryLedger();
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    meter({
      price: PRICE,
      provider: PROVIDER,
      vault,
      chain: localChain,
      publicClient,
      // No wallet: auto-settlement is off so tests stay deterministic.
      ledger,
      settleAt: usdc("1000"),
    }),
  );
  app.post("/v1/work", (req, res) => res.json({ ok: true, charged: req.ratchet.charged.toString() }));

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const voucher = (amount, opts = {}) =>
  signVoucher({
    wallet: opts.wallet ?? payer,
    vault: opts.vault ?? vault,
    chainId: localChain.id,
    channelId: opts.channelId ?? channelId,
    cumulativeAmount: amount,
  });

const call = (v) =>
  fetch(`${baseUrl}/v1/work`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(v ? { [VOUCHER_HEADER]: encodeVoucher(v) } : {}),
    },
    body: JSON.stringify({ text: "hello" }),
  });

describe("unpaid requests", () => {
  test("answers 402 with machine-readable terms", async () => {
    const res = await call(null);
    assert.equal(res.status, 402);

    const body = await res.json();
    assert.equal(body.error, "payment_required");
    assert.equal(body.ratchet.vault.toLowerCase(), vault.toLowerCase());
    assert.equal(body.ratchet.provider.toLowerCase(), PROVIDER.toLowerCase());
    assert.equal(body.ratchet.price, PRICE.toString());
    assert.equal(body.ratchet.chainId, localChain.id);

    // The same terms are on the header, so a client need not parse the body.
    const header = res.headers.get("x-ratchet-accept");
    assert.ok(header);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64").toString("utf8")), body.ratchet);
  });

  test("rejects a malformed voucher without touching the chain", async () => {
    const res = await fetch(`${baseUrl}/v1/work`, {
      method: "POST",
      headers: { "content-type": "application/json", [VOUCHER_HEADER]: "not-base64-at-all" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "malformed_voucher");
  });
});

describe("paid requests", () => {
  test("serves the request and reports the charge", async () => {
    const res = await call(await voucher(PRICE));
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.charged, PRICE.toString());
    assert.equal(res.headers.get("x-ratchet-cumulative"), PRICE.toString());
  });

  test("requires each call to ratchet the cumulative forward", async () => {
    // Replaying the voucher that already paid for the previous call.
    const res = await call(await voucher(PRICE));
    assert.equal(res.status, 402);

    const body = await res.json();
    assert.equal(body.error, "insufficient_payment");
    assert.equal(body.ratchet.requiredCumulative, (PRICE * 2n).toString());
  });

  test("rejects an increment smaller than the price", async () => {
    const res = await call(await voucher(PRICE + usdc("0.0005")));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "insufficient_payment");
  });

  test("accepts a correctly incremented voucher", async () => {
    const res = await call(await voucher(PRICE * 2n));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-ratchet-cumulative"), (PRICE * 2n).toString());
  });

  test("accepts an overpayment and books all of it", async () => {
    const res = await call(await voucher(usdc("0.5")));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-ratchet-cumulative"), usdc("0.5").toString());
  });
});

describe("forgery and abuse", () => {
  test("rejects a voucher signed by someone other than the payer", async () => {
    const res = await call(await voucher(usdc("0.6"), { wallet: stranger }));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "bad_signature");
  });

  test("rejects a voucher signed for a different vault", async () => {
    const otherVault = await deployVault(0);
    const res = await call(await voucher(usdc("0.6"), { vault: otherVault }));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "bad_signature");
  });

  test("rejects a voucher authorising more than the channel holds", async () => {
    const res = await call(await voucher(usdc("1.5")));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "exceeds_deposit");
  });

  test("rejects an unknown channel", async () => {
    const res = await call(await voucher(PRICE, { channelId: `0x${"ab".repeat(32)}` }));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "unknown_channel");
  });

  test("rejects a channel that pays a different provider", async () => {
    const { channelId: wrong } = await openChannel({
      wallet: payer,
      publicClient,
      vault,
      provider: account(4).address, // not us
      deposit: usdc("1"),
      challengeBlocks: DAY_BLOCKS,
    });
    const res = await call(await voucher(PRICE, { channelId: wrong }));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "channel_wrong_provider");
  });

  test("rejects a channel whose challenge window is too short to be safe", async () => {
    const { channelId: hasty } = await openChannel({
      wallet: payer,
      publicClient,
      vault,
      provider: PROVIDER,
      deposit: usdc("1"),
      challengeBlocks: 7_500n, // the contract floor, but below this server's bar
    });

    const app = express();
    app.use(
      "/v1",
      meter({
        price: PRICE,
        provider: PROVIDER,
        vault,
        chain: localChain,
        publicClient,
        minChallengeBlocks: DAY_BLOCKS,
        settleAt: usdc("1000"),
      }),
    );
    app.post("/v1/work", (_req, res) => res.json({ ok: true }));
    const strict = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });

    try {
      const res = await fetch(`http://127.0.0.1:${strict.address().port}/v1/work`, {
        method: "POST",
        headers: { [VOUCHER_HEADER]: encodeVoucher(await voucher(PRICE, { channelId: hasty })) },
      });
      assert.equal(res.status, 402);
      assert.equal((await res.json()).error, "channel_challenge_too_short");
    } finally {
      strict.close();
    }
  });
});

describe("concurrency", () => {
  test("parallel calls on one channel each pay exactly once", async () => {
    // A fresh server + channel so the ledger starts clean.
    const { channelId: fresh } = await openChannel({
      wallet: payer,
      publicClient,
      vault,
      provider: PROVIDER,
      deposit: usdc("1"),
      challengeBlocks: DAY_BLOCKS,
    });

    const freshLedger = new MemoryLedger();
    const app = express();
    app.use(
      "/v1",
      meter({
        price: PRICE,
        provider: PROVIDER,
        vault,
        chain: localChain,
        publicClient,
        ledger: freshLedger,
        settleAt: usdc("1000"),
      }),
    );
    app.post("/v1/work", (_req, res) => res.json({ ok: true }));
    const s = await new Promise((r) => {
      const srv = app.listen(0, () => r(srv));
    });

    try {
      const url = `http://127.0.0.1:${s.address().port}/v1/work`;
      const N = 25;

      // Pre-sign a correctly ascending ladder, then fire them all at once out of order.
      const ladder = [];
      for (let i = 1; i <= N; i++) {
        ladder.push(await signVoucher({
          wallet: payer,
          vault,
          chainId: localChain.id,
          channelId: fresh,
          cumulativeAmount: PRICE * BigInt(i),
        }));
      }
      const shuffled = [...ladder].sort(() => Math.random() - 0.5);

      const results = await Promise.all(
        shuffled.map((v) =>
          fetch(url, { method: "POST", headers: { [VOUCHER_HEADER]: encodeVoucher(v) } }),
        ),
      );

      const ok = results.filter((r) => r.status === 200).length;
      const state = freshLedger.get(fresh);

      // Out-of-order vouchers may be refused, but the ledger must never book
      // more revenue than the highest voucher actually authorises, and never
      // serve more calls than were paid for.
      assert.equal(state.owed, PRICE * BigInt(N));
      assert.ok(ok <= N, `served ${ok} calls for ${N} vouchers`);
      assert.equal(state.calls, ok);
      assert.equal(state.owed / PRICE >= BigInt(ok), true);
    } finally {
      s.close();
    }
  });
});

describe("client", () => {
  test("negotiates, opens a channel, and pays without being told how", async () => {
    const agent = new RatchetClient({
      wallet: walletFor(5),
      publicClient,
      chain: localChain,
      budget: "0.05",
      deposit: "0.05",
    });

    const first = await agent.fetch(`${baseUrl}/v1/work`, { method: "POST" });
    assert.equal(first.status, 200);
    assert.equal(agent.stats.channelsOpened, 1);

    // Subsequent calls reuse the channel and skip the 402 entirely.
    const retriesAfterFirst = agent.stats.retries;
    for (let i = 0; i < 5; i++) {
      const res = await agent.fetch(`${baseUrl}/v1/work`, { method: "POST" });
      assert.equal(res.status, 200);
    }
    assert.equal(agent.stats.retries, retriesAfterFirst, "should not re-negotiate after the first call");
    assert.equal(agent.stats.paid, PRICE * 6n);
    assert.equal(agent.stats.channelsOpened, 1);
  });

  test("refuses to exceed its budget", async () => {
    const agent = new RatchetClient({
      wallet: walletFor(6),
      publicClient,
      chain: localChain,
      budget: usdc("0.003"),
      deposit: usdc("0.05"),
    });

    for (let i = 0; i < 3; i++) {
      assert.equal((await agent.fetch(`${baseUrl}/v1/work`, { method: "POST" })).status, 200);
    }

    await assert.rejects(
      agent.fetch(`${baseUrl}/v1/work`, { method: "POST" }),
      /Budget exhausted/,
    );
  });
});
