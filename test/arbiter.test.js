/**
 * The arbiter API: terms and a delivery in, a signed ruling out.
 *
 * Covers every outcome, the commitments that force an abstain, the request
 * validation, the EIP-712 attestation an escrow contract verifies, and the
 * guard that stops the arbiter being used to fetch private network addresses.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, keccak256, toHex } from "viem";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

import { createArbiter } from "../arbiter/app.js";
import { verifyAttestation, OUTCOME_CODE } from "../arbiter/attestation.js";
import { createSafeFetch, isBlockedAddress, assertPublicUrl } from "../arbiter/safe-fetch.js";
import { jobSpec, deliverable, hashDocument } from "../evaluator/spec.js";
import { ContentStore } from "../evaluator/store.js";

const arbiterKey = privateKeyToAccount(generatePrivateKey());
const strangerKey = privateKeyToAccount(generatePrivateKey());

const TERMS = jobSpec({
  language: "python",
  timeoutMs: 8000,
  tests: [
    { name: "adds two numbers", stdin: "2 3", expect: { stdout: "5" } },
    { name: "handles zero", stdin: "0 0", expect: { stdout: "0" } },
    { name: "handles negatives", stdin: "-4 2", expect: { stdout: "-2" } },
  ],
});
const GOOD = deliverable("a, b = map(int, input().split())\nprint(a + b)");
const BUGGY = deliverable("a, b = map(int, input().split())\nprint(a * b)");
const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CASE_ID = keccak256(toHex("case-1"));

async function serve(app) {
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const inline = (terms, work, extra = {}) => ({ terms: { document: terms }, delivery: { document: work }, ...extra });

let open;
let local;
let store;

before(async () => {
  open = await serve(createArbiter({ account: arbiterKey, backend: "process" }).app);
  local = await serve(createArbiter({ account: arbiterKey, backend: "process", allowPrivateUrls: true }).app);
  store = new ContentStore();
  await store.listen();
});

after(() => {
  open?.server.close();
  local?.server.close();
  store?.close();
});

describe("rulings", () => {
  test("passes working code and signs the ruling", async () => {
    const res = await post(open.base, "/v1/rulings", inline(TERMS, GOOD));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.verdict.outcome, "passed");
    assert.equal(body.verdict.score, 100);
    assert.equal(body.hash, hashDocument(body.verdict), "hash is over the canonical ruling");
    const signer = await recoverMessageAddress({ message: { raw: body.hash }, signature: body.signature });
    assert.equal(signer, arbiterKey.address);
    assert.equal(body.evaluator, arbiterKey.address);
  });

  test("fails buggy code with the failing tests named", async () => {
    const { verdict } = await (await post(open.base, "/v1/rulings", inline(TERMS, BUGGY))).json();
    assert.equal(verdict.outcome, "failed");
    assert.equal(verdict.score, 33);
    assert.deepEqual(
      verdict.tests.filter((t) => !t.passed).map((t) => t.name),
      ["adds two numbers", "handles negatives"],
    );
  });

  test("abstains when the delivery doesn't match its committed hash", async () => {
    const res = await post(open.base, "/v1/rulings", {
      terms: { document: TERMS },
      delivery: { document: BUGGY, hash: hashDocument(GOOD) },
    });
    const { verdict } = await res.json();
    assert.equal(verdict.outcome, "abstain");
    assert.equal(verdict.code, "deliverable_hash_mismatch");
  });

  test("abstains when the terms don't match their committed hash", async () => {
    const res = await post(open.base, "/v1/rulings", {
      terms: { document: TERMS, hash: hashDocument(GOOD) },
      delivery: { document: GOOD },
    });
    const { verdict } = await res.json();
    assert.equal(verdict.outcome, "abstain");
    assert.equal(verdict.code, "spec_hash_mismatch");
  });

  test("fetches terms and delivery by URI and checks them against their hashes", async () => {
    const terms = store.put(TERMS);
    const work = store.put(GOOD);
    const res = await post(local.base, "/v1/rulings", {
      terms: { uri: terms.uri, hash: terms.hash },
      delivery: { uri: work.uri, hash: work.hash },
      reference: "escrow-x:case-7",
    });
    const { verdict } = await res.json();
    assert.equal(verdict.outcome, "passed");
    assert.equal(verdict.jobId, "escrow-x:case-7", "the caller's reference is carried into the ruling");
  });

  test("a stored ruling can be fetched again by its hash", async () => {
    const issued = await (await post(open.base, "/v1/rulings", inline(TERMS, GOOD))).json();
    const again = await (await fetch(`${open.base}/v1/rulings/${issued.hash}`)).json();
    assert.deepEqual(again.verdict, issued.verdict);
    assert.equal(again.signature, issued.signature);
    assert.equal((await fetch(`${open.base}/v1/rulings/0x${"0".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${open.base}/v1/rulings/not-a-hash`)).status, 400);
  });
});

describe("request validation", () => {
  const withBoth = { uri: "https://x.test/a", hash: hashDocument(TERMS), document: TERMS };
  const bad = [
    ["an empty body", {}],
    ["terms with both a uri and a document", { terms: withBoth, delivery: { document: GOOD } }],
    ["a uri without the committed hash", { terms: { uri: "https://x.test/a" }, delivery: { document: GOOD } }],
    ["a malformed hash", { terms: { document: TERMS, hash: "0x1234" }, delivery: { document: GOOD } }],
    ["a document that isn't an object", { terms: { document: "print(1)" }, delivery: { document: GOOD } }],
    ["a reference that is too long", inline(TERMS, GOOD, { reference: "x".repeat(201) })],
    ["attest with a bad escrow address", inline(TERMS, GOOD, { attest: { chainId: 1, escrow: "0x12", caseId: CASE_ID } })],
    ["attest with a bad case id", inline(TERMS, GOOD, { attest: { chainId: 1, escrow: ESCROW, caseId: "7" } })],
  ];
  for (const [name, body] of bad) {
    test(`rejects ${name} with 400`, async () => {
      const res = await post(open.base, "/v1/rulings", body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "bad_request");
    });
  }

  test("rejects invalid JSON with 400, not 500", async () => {
    const res = await post(open.base, "/v1/rulings", "{not json");
    assert.equal(res.status, 400);
  });

  test("answers 503 with retry-after when every sandbox is busy", async () => {
    const busy = await serve(createArbiter({ account: arbiterKey, backend: "process", maxConcurrent: 0 }).app);
    try {
      const res = await post(busy.base, "/v1/rulings", inline(TERMS, GOOD));
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "2");
    } finally {
      busy.server.close();
    }
  });
});

describe("attestations for escrow contracts", () => {
  const attest = { chainId: 31337, escrow: ESCROW, caseId: CASE_ID };

  test("signs an EIP-712 ruling bound to the escrow, case and commitments", async () => {
    const body = await (await post(open.base, "/v1/rulings", inline(TERMS, BUGGY, { attest }))).json();
    const { domain, message, signature } = body.attestation;

    assert.equal(domain.verifyingContract, ESCROW);
    assert.equal(domain.chainId, 31337);
    assert.equal(message.caseId, CASE_ID);
    assert.equal(message.outcome, OUTCOME_CODE.failed);
    assert.equal(message.score, 33);
    assert.equal(message.rulingHash, body.hash);
    assert.equal(message.termsHash, hashDocument(TERMS));
    assert.equal(message.deliveryHash, hashDocument(BUGGY));
    assert.equal(await verifyAttestation({ address: arbiterKey.address, domain, message, signature }), true);
  });

  test("an attestation doesn't verify for a different escrow", async () => {
    const { attestation } = await (await post(open.base, "/v1/rulings", inline(TERMS, GOOD, { attest }))).json();
    const other = { ...attestation.domain, verifyingContract: "0x0000000000000000000000000000000000000001" };
    const ok = await verifyAttestation({
      address: arbiterKey.address,
      domain: other,
      message: attestation.message,
      signature: attestation.signature,
    });
    assert.equal(ok, false);
  });
});

describe("POST /v1/check", () => {
  test("confirms a genuine ruling and its attestation", async () => {
    const attest = { chainId: 31337, escrow: ESCROW, caseId: CASE_ID };
    const issued = await (await post(open.base, "/v1/rulings", inline(TERMS, GOOD, { attest }))).json();
    const check = await (await post(open.base, "/v1/check", issued)).json();
    assert.equal(check.valid, true);
    assert.equal(check.hashMatches, true);
    assert.equal(check.signedByThisArbiter, true);
    assert.equal(check.attestationValid, true);
  });

  test("catches an edited ruling and a signature from someone else", async () => {
    const issued = await (await post(open.base, "/v1/rulings", inline(TERMS, BUGGY))).json();

    const edited = { ...issued, verdict: { ...issued.verdict, outcome: "passed" } };
    const editedCheck = await (await post(open.base, "/v1/check", edited)).json();
    assert.equal(editedCheck.hashMatches, false);
    assert.equal(editedCheck.valid, false);

    const forged = { ...issued, signature: await strangerKey.signMessage({ message: { raw: issued.hash } }) };
    const forgedCheck = await (await post(open.base, "/v1/check", forged)).json();
    assert.equal(forgedCheck.signedByThisArbiter, false);
    assert.equal(forgedCheck.valid, false);
  });
});

describe("paid rulings over x402", () => {
  let paid;
  before(async () => {
    const gateway = createGatewayMiddleware({
      sellerAddress: arbiterKey.address,
      networks: "eip155:5042002",
      facilitatorUrl: "https://gateway-api-testnet.circle.com",
      description: "A Verdict ruling",
    });
    paid = await serve(createArbiter({ account: arbiterKey, backend: "process", payment: { gateway } }).app);
  });
  after(() => paid?.server.close());

  test("asks for $0.01 before judging", async () => {
    const res = await post(paid.base, "/v1/rulings", inline(TERMS, GOOD));
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header, "an x402 challenge header is present");
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const offer = challenge.accepts?.[0] ?? {};
    assert.equal(offer.network, "eip155:5042002");
    assert.equal(offer.payTo?.toLowerCase(), arbiterKey.address.toLowerCase());
    assert.equal(offer.amount ?? offer.maxAmountRequired, "10000", "one cent in 6-decimal USDC");
  });

  test("never charges for a malformed request", async () => {
    const res = await post(paid.base, "/v1/rulings", { terms: { document: TERMS } });
    assert.equal(res.status, 400);
  });

  test("pricing says the same price applies to every outcome", async () => {
    const pricing = await (await fetch(`${paid.base}/v1/pricing`)).json();
    assert.equal(pricing.perRuling, "$0.01");
    assert.equal(pricing.sameForEveryOutcome, true);
  });
});

describe("hardening", () => {
  /** A paywall that takes a moment, like a real facilitator round-trip. */
  const slowPaywall = (verdictOf = () => true) => ({
    price: "$0.01",
    gateway: {
      require: () => async (req, res, next) => {
        await new Promise((r) => setTimeout(r, 80));
        if (!verdictOf(req)) return res.status(402).json({ error: "payment_required" });
        next();
      },
    },
  });

  test("a burst can't exceed the concurrency limit while payments are being checked", async () => {
    const svc = await serve(
      createArbiter({ account: arbiterKey, backend: "process", maxConcurrent: 1, payment: slowPaywall() }).app,
    );
    try {
      const statuses = await Promise.all(
        [0, 1, 2].map(() => post(svc.base, "/v1/rulings", inline(TERMS, GOOD)).then((r) => r.status)),
      );
      assert.deepEqual(statuses.sort(), [200, 503, 503]);
    } finally {
      svc.server.close();
    }
  });

  test("a slot is given back when payment is refused", async () => {
    const svc = await serve(
      createArbiter({ account: arbiterKey, backend: "process", maxConcurrent: 1, payment: slowPaywall(() => false) }).app,
    );
    try {
      assert.equal((await post(svc.base, "/v1/rulings", inline(TERMS, GOOD))).status, 402);
      assert.equal((await post(svc.base, "/v1/rulings", inline(TERMS, GOOD))).status, 402, "not 503: the slot came back");
    } finally {
      svc.server.close();
    }
  });

  test("rate limits each client", async () => {
    const svc = await serve(createArbiter({ account: arbiterKey, backend: "process", rateLimitPerMinute: 2 }).app);
    try {
      const body = { terms: { document: TERMS } }; // malformed on purpose: fast, and still counted
      assert.equal((await post(svc.base, "/v1/rulings", body)).status, 400);
      assert.equal((await post(svc.base, "/v1/rulings", body)).status, 400);
      const third = await post(svc.base, "/v1/rulings", body);
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0);
    } finally {
      svc.server.close();
    }
  });

  test("keeps at most maxOnDisk rulings on disk, dropping the oldest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verdict-rulings-"));
    const svc = await serve(createArbiter({ account: arbiterKey, backend: "process", rulingsDir: dir, maxOnDisk: 2 }).app);
    try {
      const hashes = [];
      for (const n of [1, 2, 3]) {
        const terms = jobSpec({ language: "python", tests: [{ name: `prints ${n}`, expect: { stdout: String(n) } }] });
        const work = deliverable(`print(${n})`);
        hashes.push((await (await post(svc.base, "/v1/rulings", inline(terms, work))).json()).hash);
      }
      const files = readdirSync(dir).sort();
      assert.equal(files.length, 2);
      assert.ok(!files.includes(`ruling-${hashes[0].toLowerCase()}.json`), "the oldest was dropped");
    } finally {
      svc.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an internal failure becomes a signed abstain, not a 500", async () => {
    const broken = async () => {
      throw new Error("sandbox exploded");
    };
    const svc = await serve(createArbiter({ account: arbiterKey, backend: "process", evaluateImpl: broken }).app);
    try {
      const res = await post(svc.base, "/v1/rulings", inline(TERMS, GOOD));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.verdict.outcome, "abstain");
      assert.equal(body.verdict.code, "evaluator_error");
      assert.ok(!JSON.stringify(body).includes("sandbox exploded"), "internals don't leak to the caller");
      const signer = await recoverMessageAddress({ message: { raw: body.hash }, signature: body.signature });
      assert.equal(signer, arbiterKey.address);
    } finally {
      svc.server.close();
    }
  });
});

describe("safe fetch", () => {
  test("blocks loopback, private, link-local, CGNAT and mapped addresses", () => {
    const blocked = ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
  });

  test("refuses a public-looking name that resolves to a private address", async () => {
    const lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await assert.rejects(assertPublicUrl("https://innocent.example/terms.json", { lookup }), /non-public/);
  });

  test("refuses non-http schemes", async () => {
    await assert.rejects(assertPublicUrl("file:///etc/passwd"), /not allowed/);
  });

  test("re-checks every redirect hop", async () => {
    const lookup = async (host) => [{ address: host === "public.example" ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "http://internal.example/secret" } });
    const safeFetch = createSafeFetch({ lookup, fetchImpl });
    await assert.rejects(safeFetch("https://public.example/terms.json"), /non-public/);
  });

  test("aborts a body larger than the ceiling", async () => {
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const fetchImpl = async () => new Response("x".repeat(2048), { status: 200 });
    const safeFetch = createSafeFetch({ lookup, fetchImpl, maxBytes: 1024 });
    await assert.rejects(safeFetch("https://public.example/big.json"), /exceeds 1024 bytes/);
  });

  test("blocks private IPv4 hidden inside every IPv6 notation", () => {
    // The URL parser rewrites [::ffff:169.254.169.254] as ::ffff:a9fe:a9fe, so
    // string-prefix checks miss it. Every form below must be caught numerically.
    const urls = [
      "http://[::ffff:169.254.169.254]/", // IPv4-mapped, normalised to hex groups
      "http://[::ffff:127.0.0.1]/",
      "http://[::127.0.0.1]/", // IPv4-compatible
      "http://[64:ff9b::a9fe:a9fe]/", // NAT64
      "http://[2002:7f00:1::]/", // 6to4 around 127.0.0.1
      "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", // Teredo
      "http://[fe80::1]/", // link-local
    ];
    for (const u of urls) {
      const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
      assert.equal(isBlockedAddress(host), true, `${u} → ${host}`);
    }
    for (const ok of ["2001:4860:4860::8888", "64:ff9b::808:808", "::ffff:8.8.8.8"]) {
      assert.equal(isBlockedAddress(ok), false, ok);
    }
  });

  test("the open arbiter abstains rather than fetch a private URL", async () => {
    const terms = store.put(TERMS);
    const res = await post(open.base, "/v1/rulings", {
      terms: { uri: terms.uri, hash: terms.hash },
      delivery: { document: GOOD },
    });
    const { verdict } = await res.json();
    assert.equal(verdict.outcome, "abstain");
    assert.equal(verdict.code, "spec_unavailable");
  });
});
