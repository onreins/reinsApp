/**
 * Metering middleware: the places a caller could get work without paying for
 * it, and the places a provider could charge for work it did not do.
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
import { meter, MemoryLedger, settleAll, VOUCHER_HEADER } from "../src/server.js";
import { signVoucher, encodeVoucher } from "../src/voucher.js";
import { openChannel, getChannel } from "../src/vault.js";
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
  app.post("/v1/work", (req, res) => res.json({ ok: true, ceiling: req.ratchet.ceiling.toString() }));

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

const call = (v, url = `${baseUrl}/v1/work`) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(v ? { [VOUCHER_HEADER]: encodeVoucher(v) } : {}),
    },
    body: JSON.stringify({ text: "hello" }),
  });

/** Stand up an isolated metered service with its own channel and ledger. */
async function isolated({ price = PRICE, handler, deposit = usdc("1"), settleAt = usdc("1000"), wallet } = {}) {
  const { channelId: id } = await openChannel({
    wallet: payer,
    publicClient,
    vault,
    provider: PROVIDER,
    deposit,
    challengeBlocks: DAY_BLOCKS,
  });

  const own = new MemoryLedger();
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    meter({ price, provider: PROVIDER, vault, chain: localChain, publicClient, ledger: own, settleAt, wallet }),
  );
  app.post("/v1/work", handler ?? ((_req, res) => res.json({ ok: true })));

  const srv = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });

  return {
    channelId: id,
    ledger: own,
    url: `http://127.0.0.1:${srv.address().port}/v1/work`,
    close: () => srv.close(),
  };
}

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

    assert.equal((await res.json()).ok, true);
    assert.equal(res.headers.get("x-ratchet-cumulative"), PRICE.toString());
  });

  test("requires each call to ratchet the cumulative forward", async () => {
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

  test("authorising extra headroom does not increase what is charged", async () => {
    // The caller signs for far more than one call; only one call's worth is booked.
    const before = BigInt(ledger.get(channelId).owed);
    const res = await call(await voucher(usdc("0.5")));
    assert.equal(res.status, 200);

    const after = BigInt(ledger.get(channelId).owed);
    assert.equal(after - before, PRICE, "a generous voucher must still cost one call");
    assert.equal(res.headers.get("x-ratchet-cumulative"), after.toString());
  });
});

describe("variable-cost work", () => {
  test("charges what the handler reports, not the ceiling", async () => {
    const svc = await isolated({
      price: usdc("0.01"), // generous ceiling
      handler: (req, res) => {
        req.ratchet.charge(usdc("0.0004")); // actual cost
        res.json({ ok: true });
      },
    });

    try {
      const v = await signVoucher({
        wallet: payer,
        vault,
        chainId: localChain.id,
        channelId: svc.channelId,
        cumulativeAmount: usdc("0.01"),
      });
      const res = await call(v, svc.url);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-ratchet-charged"), usdc("0.0004").toString());
      assert.equal(svc.ledger.get(svc.channelId).owed, usdc("0.0004"));
    } finally {
      svc.close();
    }
  });

  test("a handler cannot charge more than the ceiling it was authorised", async () => {
    const svc = await isolated({
      price: usdc("0.001"),
      handler: (req, res) => {
        req.ratchet.charge(usdc("999")); // greedy
        res.json({ ok: true });
      },
    });

    try {
      const v = await signVoucher({
        wallet: payer,
        vault,
        chainId: localChain.id,
        channelId: svc.channelId,
        cumulativeAmount: usdc("0.001"),
      });
      const res = await call(v, svc.url);

      assert.equal(res.status, 200);
      assert.equal(svc.ledger.get(svc.channelId).owed, usdc("0.001"), "clamped to the ceiling");
    } finally {
      svc.close();
    }
  });

  test("a handler that reports nothing is charged the full ceiling", async () => {
    const svc = await isolated({
      price: usdc("0.002"),
      handler: (_req, res) => res.json({ ok: true }), // forgot to charge
    });

    try {
      const v = await signVoucher({
        wallet: payer,
        vault,
        chainId: localChain.id,
        channelId: svc.channelId,
        cumulativeAmount: usdc("0.002"),
      });
      assert.equal((await call(v, svc.url)).status, 200);

      // Fail closed: we did the work, so we bill for it.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(svc.ledger.get(svc.channelId).owed, usdc("0.002"));
    } finally {
      svc.close();
    }
  });

  test("never settles a voucher worth more than was actually used", async () => {
    // The whole point: the caller authorises ceilings, we redeem only usage.
    const svc = await isolated({
      price: usdc("0.01"),
      wallet: providerWallet,
      settleAt: usdc("0.02"),
      handler: (req, res) => {
        req.ratchet.charge(usdc("0.003")); // always well under the ceiling
        res.json({ ok: true });
      },
    });

    try {
      for (let i = 1; i <= 12; i++) {
        const state = svc.ledger.get(svc.channelId);
        const booked = state ? state.owed : 0n;
        const v = await signVoucher({
          wallet: payer,
          vault,
          chainId: localChain.id,
          channelId: svc.channelId,
          cumulativeAmount: booked + usdc("0.01"),
        });
        assert.equal((await call(v, svc.url)).status, 200);
      }

      await new Promise((r) => setTimeout(r, 1500)); // let settlement land

      const state = svc.ledger.get(svc.channelId);
      const onChain = await getChannel({ publicClient, vault, channelId: svc.channelId });

      assert.equal(state.owed, usdc("0.036"), "12 calls at 0.003");
      assert.ok(
        onChain.claimed <= state.owed,
        `settled ${onChain.claimed} must never exceed used ${state.owed}`,
      );
      assert.ok(onChain.claimed > 0n, "something should have settled");

      // And the settleable voucher we are holding is likewise never excessive.
      if (state.settleable) {
        assert.ok(state.settleable.cumulativeAmount <= state.owed);
      }
    } finally {
      svc.close();
    }
  });

  test("settleAll drains the remaining balance without overcharging", async () => {
    const svc = await isolated({
      price: usdc("0.01"),
      handler: (req, res) => {
        req.ratchet.charge(usdc("0.002"));
        res.json({ ok: true });
      },
    });

    try {
      for (let i = 1; i <= 5; i++) {
        const booked = svc.ledger.get(svc.channelId)?.owed ?? 0n;
        const v = await signVoucher({
          wallet: payer,
          vault,
          chainId: localChain.id,
          channelId: svc.channelId,
          cumulativeAmount: booked + usdc("0.01"),
        });
        await call(v, svc.url);
      }

      await settleAll({ ledger: svc.ledger, wallet: providerWallet, publicClient, vault });

      const state = svc.ledger.get(svc.channelId);
      const onChain = await getChannel({ publicClient, vault, channelId: svc.channelId });
      assert.ok(onChain.claimed <= state.owed);
    } finally {
      svc.close();
    }
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
  test("parallel calls never book more than was authorised", async () => {
    const svc = await isolated({ price: PRICE });

    try {
      const N = 25;
      const ladder = [];
      for (let i = 1; i <= N; i++) {
        ladder.push(
          await signVoucher({
            wallet: payer,
            vault,
            chainId: localChain.id,
            channelId: svc.channelId,
            cumulativeAmount: PRICE * BigInt(i),
          }),
        );
      }
      const shuffled = [...ladder].sort(() => Math.random() - 0.5);

      const results = await Promise.all(shuffled.map((v) => call(v, svc.url)));
      await new Promise((r) => setTimeout(r, 100)); // let finish handlers book

      const served = results.filter((r) => r.status === 200).length;
      const state = svc.ledger.get(svc.channelId);
      const highest = PRICE * BigInt(N);

      // Reserving before serving means out-of-order vouchers get refused rather
      // than double-spent. What must hold: we bill exactly once per served call,
      // and never beyond what the caller actually signed for.
      assert.equal(state.owed, PRICE * BigInt(served), "one charge per served call");
      assert.ok(state.owed <= highest, "never books beyond the highest authorisation");
      assert.equal(state.reserved, 0n, "every reservation resolved");
      assert.ok(served > 0, "at least some calls should succeed");
    } finally {
      svc.close();
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
    assert.equal(agent.stats.negotiations, 1);

    // Subsequent calls reuse the channel and skip the 402 entirely.
    for (let i = 0; i < 5; i++) {
      assert.equal((await agent.fetch(`${baseUrl}/v1/work`, { method: "POST" })).status, 200);
    }

    assert.equal(agent.stats.negotiations, 1, "should not re-negotiate after the first call");
    assert.equal(agent.stats.channelsOpened, 1);
    assert.equal(agent.summary().spent, PRICE * 6n);
  });

  test("tracks actual spend, not authorised ceilings", async () => {
    const svc = await isolated({
      price: usdc("0.01"),
      handler: (req, res) => {
        req.ratchet.charge(usdc("0.001"));
        res.json({ ok: true });
      },
    });

    try {
      const agent = new RatchetClient({
        wallet: walletFor(7),
        publicClient,
        chain: localChain,
        budget: "0.20",
        deposit: "0.20",
      });

      for (let i = 0; i < 5; i++) {
        assert.equal((await agent.fetch(svc.url, { method: "POST" })).status, 200);
      }

      const summary = agent.summary();
      // Five calls at a tenth of the ceiling: spend must reflect usage.
      assert.equal(summary.spent, usdc("0.005"));
      assert.ok(
        summary.authorised > summary.spent,
        "authorisation runs ahead of spend, as designed",
      );
      assert.equal(summary.averagePerCall, usdc("0.001"));
    } finally {
      svc.close();
    }
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
