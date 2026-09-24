/**
 * The Verdict arbiter API: send terms and a delivery, get a signed ruling.
 *
 * This is the product surface for escrow protocols that already hold funds and
 * need a neutral party to decide who gets them. The ERC-8183 evaluator daemon
 * (evaluator/daemon.js) serves jobs on our own escrow; this serves everyone
 * else's.
 *
 *   POST /v1/rulings          judge a delivery against its terms
 *   GET  /v1/rulings/:hash    fetch a ruling that was issued earlier
 *   POST /v1/check            check a ruling's hash, signature and attestation
 *   GET  /v1/pricing          what a ruling costs
 *   GET  /health              liveness and configuration
 *
 * A request names the terms and the delivery either by URI plus the hash the
 * parties committed to, or inline as a document. Verdict fetches, checks each
 * against its hash, re-runs the tests, and returns:
 *
 *   - the full ruling, and a personal_sign signature over its hash
 *   - optionally an EIP-712 attestation bound to one escrow contract, which
 *     that contract can verify on-chain to release or refund (attestation.js)
 *
 * Every outcome is a 200: `abstain` is an answer, not an error. 4xx means the
 * request itself was malformed.
 */
import express from "express";
import { recoverMessageAddress } from "viem";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { evaluate, OUTCOME } from "../evaluator/verify.js";
import { canonicalize, hashDocument, VERDICT_VERSION } from "../evaluator/spec.js";
import { createSafeFetch } from "./safe-fetch.js";
import { parseAttestRequest, signAttestation, verifyAttestation } from "./attestation.js";

export const DEFAULT_PRICE = "$0.01";
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_URI = 2048;
const MAX_REFERENCE = 200;
const MAX_CACHED_RULINGS = 10_000;
const MAX_RULINGS_ON_DISK = 10_000;
const RATE_WINDOW_MS = 60_000;

class BadRequest extends Error {}

/** Turn a { uri, hash } or { document, hash? } reference into { uri, hash }. */
function toCommitment(ref, field) {
  if (!ref || typeof ref !== "object") throw new BadRequest(`${field} is required`);
  const hasUri = typeof ref.uri === "string" && ref.uri.length > 0;
  const hasDoc = ref.document !== undefined;
  if (hasUri === hasDoc) throw new BadRequest(`${field} needs exactly one of "uri" or "document"`);
  if (ref.hash !== undefined && !BYTES32.test(ref.hash)) {
    throw new BadRequest(`${field}.hash must be a 0x-prefixed bytes32`);
  }
  if (hasUri) {
    if (ref.uri.length > MAX_URI) throw new BadRequest(`${field}.uri is longer than ${MAX_URI} characters`);
    if (!ref.hash) throw new BadRequest(`${field}.hash is required with a uri: it is what the parties committed to`);
    return { uri: ref.uri, hash: ref.hash };
  }
  if (ref.document === null || typeof ref.document !== "object") {
    throw new BadRequest(`${field}.document must be a JSON object`);
  }
  const text = canonicalize(ref.document);
  return {
    uri: `data:application/json;base64,${Buffer.from(text).toString("base64")}`,
    hash: ref.hash ?? hashDocument(ref.document),
  };
}

/**
 * Rulings issued by this arbiter: bounded in memory and, if mirrored to disk,
 * bounded there too. Anyone can mint distinct rulings for free by varying a
 * byte, so an unbounded store would be a way to fill the disk.
 */
class RulingStore {
  constructor(dir, maxOnDisk = MAX_RULINGS_ON_DISK) {
    this.dir = dir ?? null;
    this.maxOnDisk = maxOnDisk;
    this.cache = new Map();
    this.onDisk = [];
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.onDisk = readdirSync(this.dir)
        .filter((f) => /^ruling-0x[0-9a-f]{64}\.json$/.test(f))
        .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .map(({ f }) => f);
    }
  }

  put(sealed) {
    const key = sealed.hash.toLowerCase();
    this.cache.set(key, sealed);
    if (this.cache.size > MAX_CACHED_RULINGS) this.cache.delete(this.cache.keys().next().value);
    if (!this.dir) return;

    const file = `ruling-${key}.json`;
    if (!this.onDisk.includes(file)) this.onDisk.push(file);
    writeFileSync(join(this.dir, file), `${JSON.stringify(sealed, null, 2)}\n`);
    while (this.onDisk.length > this.maxOnDisk) {
      const oldest = this.onDisk.shift();
      try {
        unlinkSync(join(this.dir, oldest));
      } catch {
        // already gone; nothing to reclaim
      }
    }
  }

  get(hash) {
    const key = hash.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.dir) return null;
    const file = join(this.dir, `ruling-${key}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
}

/** Validate and normalise a POST /v1/rulings body. Throws BadRequest/TypeError. */
export function parseRulingRequest(body) {
  if (!body || typeof body !== "object") throw new BadRequest("body must be a JSON object");
  const reference = body.reference ?? null;
  if (reference !== null && (typeof reference !== "string" || reference.length > MAX_REFERENCE)) {
    throw new BadRequest(`reference must be a string of at most ${MAX_REFERENCE} characters`);
  }
  return {
    terms: toCommitment(body.terms, "terms"),
    delivery: toCommitment(body.delivery, "delivery"),
    reference,
    attest: parseAttestRequest(body.attest),
  };
}

/**
 * @param {object} opts
 * @param {import("viem").LocalAccount} opts.account  The arbiter's signing key.
 * @param {string}  [opts.backend]           Sandbox backend ("docker" | "process").
 * @param {boolean} [opts.requireIsolation]  Abstain unless tests ran under Docker.
 * @param {boolean} [opts.allowPrivateUrls]  Let URIs point at private networks (tests only).
 * @param {string}  [opts.rulingsDir]        Mirror issued rulings to this directory.
 * @param {number}  [opts.maxConcurrent]     Rulings evaluated at once before answering 503.
 * @param {number}  [opts.maxOnDisk]         Rulings kept in rulingsDir before the oldest is dropped.
 * @param {number}  [opts.maxConcurrent]     Rulings evaluated at once before answering 503.
 * @param {number}  [opts.rateLimitPerMinute] Ruling requests per client IP per minute (0 disables).
 * @param {object}  [opts.payment]           { gateway, price } to charge per ruling over x402.
 * @param {Function} [opts.evaluateImpl]     Override the evaluation (tests only).
 */
export function createArbiter({
  account,
  backend,
  requireIsolation = false,
  allowPrivateUrls = false,
  rulingsDir,
  maxOnDisk,
  maxConcurrent = 4,
  rateLimitPerMinute = 60,
  payment = null,
  evaluateImpl = evaluate,
}) {
  if (!account?.address || typeof account.signTypedData !== "function") {
    throw new Error("createArbiter needs a signing account (viem LocalAccount)");
  }

  const store = new RulingStore(rulingsDir, maxOnDisk);
  const safeFetch = createSafeFetch({ allowPrivate: allowPrivateUrls });
  const price = payment?.price ?? DEFAULT_PRICE;
  const hits = new Map();
  let active = 0;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      evaluator: account.address,
      backend: backend ?? "auto",
      requireIsolation,
      paid: Boolean(payment),
      price: payment ? price : "free",
    });
  });

  app.get("/v1/pricing", (_req, res) => {
    res.json({
      perRuling: payment ? price : "free",
      sameForEveryOutcome: true,
      why: "Verdict earns the same whether work passes, fails or it abstains, so it has no reason to lean either way.",
      payment: payment ? { protocol: "x402", settlement: "Circle Gateway" } : null,
    });
  });

  const paywall = payment ? payment.gateway.require(price) : (_req, _res, next) => next();

  const validate = (req, res, next) => {
    try {
      req.ruling = parseRulingRequest(req.body);
      next();
    } catch (err) {
      if (err instanceof BadRequest || err instanceof TypeError) {
        return res.status(400).json({ error: "bad_request", message: err.message });
      }
      next(err);
    }
  };

  /** A fixed one-minute window per client address. Paying doesn't exempt anyone. */
  const rateLimit = (req, res, next) => {
    if (!rateLimitPerMinute) return next();
    const now = Date.now();
    if (hits.size > 50_000) {
      for (const [ip, w] of hits) if (now - w.start >= RATE_WINDOW_MS) hits.delete(ip);
    }
    const ip = req.ip ?? "unknown";
    const w = hits.get(ip);
    if (!w || now - w.start >= RATE_WINDOW_MS) {
      hits.set(ip, { start: now, count: 1 });
      return next();
    }
    w.count += 1;
    if (w.count > rateLimitPerMinute) {
      res.setHeader("retry-after", String(Math.ceil((w.start + RATE_WINDOW_MS - now) / 1000)));
      return res.status(429).json({ error: "rate_limited", message: `at most ${rateLimitPerMinute} rulings per minute` });
    }
    next();
  };

  /**
   * Reserve a sandbox slot before anything asynchronous happens (the x402
   * payment check is a network round-trip), and give it back whenever the
   * response ends, however it ends. Counting only inside the handler would let
   * a burst slip past the limit while payments are being verified.
   */
  const capacity = (_req, res, next) => {
    if (active >= maxConcurrent) {
      res.setHeader("retry-after", "2");
      return res.status(503).json({ error: "busy", message: "all sandboxes are in use, retry shortly" });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };

  /**
   * An internal failure is not the parties' fault, and by the time we get here
   * a paid caller has already been charged. So instead of a bare 500 they get a
   * signed abstain: no judgement was made and no money should move.
   */
  const judge = async ({ terms, delivery, reference }) => {
    try {
      return await evaluateImpl({
        specUri: terms.uri,
        specHash: terms.hash,
        deliverableUri: delivery.uri,
        deliverableHash: delivery.hash,
        jobId: reference,
        evaluator: account.address,
        backend,
        isolatedRequired: requireIsolation,
        resolveOpts: { fetchImpl: safeFetch },
      });
    } catch (err) {
      console.error("[arbiter] evaluation failed, abstaining:", err);
      return {
        spec: VERDICT_VERSION,
        jobId: reference,
        agentId: null,
        specHash: terms.hash,
        deliverableHash: delivery.hash,
        evaluator: account.address,
        evaluatedAt: new Date().toISOString(),
        outcome: OUTCOME.ABSTAIN,
        score: 0,
        reason: "the evaluator failed internally, so no judgement was made",
        code: "evaluator_error",
        tests: [],
      };
    }
  };

  const rule = async (req, res, next) => {
    const { terms, delivery, reference, attest } = req.ruling;
    try {
      const verdict = await judge({ terms, delivery, reference });

      const hash = hashDocument(verdict);
      const signature = await account.signMessage({ message: { raw: hash } });
      const attestation = attest ? await signAttestation({ account, attest, verdict, rulingHash: hash }) : null;

      const sealed = { hash, signature, verdict, attestation };
      store.put(sealed);

      res.json({
        ...sealed,
        evaluator: account.address,
        links: { self: `/v1/rulings/${hash}` },
        payment: req.payment ? { payer: req.payment.payer ?? null, price } : null,
      });
    } catch (err) {
      next(err);
    }
  };

  // Validate before charging, so a malformed request never costs anything.
  app.post("/v1/rulings", rateLimit, validate, capacity, paywall, rule);

  app.get("/v1/rulings/:hash", (req, res) => {
    if (!BYTES32.test(req.params.hash)) {
      return res.status(400).json({ error: "bad_request", message: "hash must be a 0x-prefixed bytes32" });
    }
    const sealed = store.get(req.params.hash);
    if (!sealed) return res.status(404).json({ error: "not_found", message: "no ruling with that hash" });
    res.json({ ...sealed, evaluator: account.address });
  });

  /** Anyone can check a ruling here, but nothing here needs trusting: it's all re-derivable. */
  app.post("/v1/check", async (req, res) => {
    const { verdict, hash, signature, attestation } = req.body ?? {};
    if (!verdict || typeof verdict !== "object" || !BYTES32.test(hash ?? "") || typeof signature !== "string") {
      return res.status(400).json({ error: "bad_request", message: "send { verdict, hash, signature }" });
    }
    const result = { hashMatches: hashDocument(verdict).toLowerCase() === hash.toLowerCase() };
    try {
      result.signer = await recoverMessageAddress({ message: { raw: hash }, signature });
    } catch {
      result.signer = null;
    }
    result.signedByThisArbiter = result.signer?.toLowerCase() === account.address.toLowerCase();
    if (attestation) {
      try {
        result.attestationValid = await verifyAttestation({ address: account.address, ...attestation });
      } catch {
        result.attestationValid = false;
      }
      result.attestationMatchesRuling = attestation.message?.rulingHash?.toLowerCase() === hash.toLowerCase();
    }
    result.valid =
      result.hashMatches &&
      result.signedByThisArbiter &&
      (attestation ? result.attestationValid && result.attestationMatchesRuling : true);
    res.json(result);
  });

  // Malformed JSON and anything unexpected. Never leak internals to the caller.
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "bad_request", message: "body is not valid JSON" });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "too_large", message: "request body exceeds 1MB" });
    }
    console.error("[arbiter] unexpected error:", err);
    res.status(500).json({ error: "internal", message: "the arbiter could not complete this ruling" });
  });

  return { app, store, address: account.address, price: payment ? price : null };
}
