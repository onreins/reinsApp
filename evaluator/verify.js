/**
 * The verification engine.
 *
 * Fetch the agreed spec and the submitted deliverable, check both against the
 * hashes committed on-chain, run the tests in the sandbox, and produce a
 * signed verdict.
 *
 * Three outcomes, not two:
 *
 *   passed   every test passed
 *   failed   the work is real but wrong
 *   abstain  we could not judge honestly
 *
 * `abstain` is the important one. If the deliverable will not fetch, or does
 * not hash to what was committed, or the spec is malformed, a neutral
 * evaluator must decline to act — not guess, and not pick the side that
 * happens to be asking. Abstaining leaves the escrow alone, and the job's own
 * expiry returns the money to the client without the evaluator taking a view.
 * An evaluator that guesses under uncertainty is worse than no evaluator,
 * because both parties relied on it.
 */
import { run } from "../src/sandbox.js";
import {
  parseJobSpec,
  parseDeliverable,
  matchesCommitment,
  hashDocument,
  canonicalize,
  VERDICT_VERSION,
  SpecError,
} from "./spec.js";

export const OUTCOME = { PASSED: "passed", FAILED: "failed", ABSTAIN: "abstain" };

const MAX_DOCUMENT_BYTES = 1024 * 1024;

/**
 * Fetch a content-addressed document.
 *
 * Supports http(s), data: and ipfs: (via a gateway). Deliberately strict about
 * size and time — a provider should not be able to stall or exhaust the
 * evaluator by pointing it at something enormous.
 */
export async function resolve(uri, { fetchImpl = globalThis.fetch, ipfsGateway = "https://ipfs.io/ipfs/", timeoutMs = 15_000 } = {}) {
  let target = uri;
  if (uri.startsWith("ipfs://")) target = ipfsGateway + uri.slice("ipfs://".length);

  if (target.startsWith("data:")) {
    const comma = target.indexOf(",");
    if (comma === -1) throw new ResolveError(`malformed data uri`, uri);
    const meta = target.slice(5, comma);
    const payload = target.slice(comma + 1);
    const text = meta.includes("base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    return parseJson(checkSize(text, uri), uri);
  }

  if (!/^https?:\/\//.test(target)) {
    throw new ResolveError(`unsupported uri scheme`, uri);
  }

  let res;
  try {
    res = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (err) {
    throw new ResolveError(`fetch failed: ${err.message}`, uri);
  }
  if (!res.ok) throw new ResolveError(`fetch returned HTTP ${res.status}`, uri);

  return parseJson(checkSize(await res.text(), uri), uri);
}

/** One size ceiling for every scheme — a data: uri is not a way around it. */
function checkSize(text, uri) {
  if (text.length > MAX_DOCUMENT_BYTES) {
    throw new ResolveError(`document exceeds ${MAX_DOCUMENT_BYTES} bytes`, uri);
  }
  return text;
}

function parseJson(text, uri) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ResolveError("document is not valid JSON", uri);
  }
}

/** Compare one test's observed output against what the spec demanded. */
function judge(test, result) {
  const reasons = [];
  const stdout = result.stdout.replace(/\r\n/g, "\n").trim();

  if (test.expect.stdout !== undefined) {
    const want = test.expect.stdout.replace(/\r\n/g, "\n").trim();
    if (stdout !== want) reasons.push(`expected stdout ${JSON.stringify(want)}, got ${JSON.stringify(stdout)}`);
  }
  if (test.expect.stdoutContains !== undefined && !stdout.includes(test.expect.stdoutContains)) {
    reasons.push(`stdout did not contain ${JSON.stringify(test.expect.stdoutContains)}`);
  }
  if (test.expect.exitCode !== undefined && result.exitCode !== test.expect.exitCode) {
    reasons.push(`expected exit code ${test.expect.exitCode}, got ${result.exitCode}`);
  }
  if (result.timedOut) reasons.push(`timed out after ${test.timeoutMs ?? "the allowed"}ms`);

  return { passed: reasons.length === 0, reasons };
}

/**
 * Run a deliverable against a spec.
 *
 * @param {object} p
 * @param {object} p.spec          The parsed job spec.
 * @param {object} p.deliverable   The parsed deliverable.
 * @param {string} [p.backend]     Sandbox backend override.
 */
export async function runTests({ spec, deliverable, backend }) {
  const tests = [];

  for (const test of spec.tests) {
    let result;
    try {
      result = await run({
        language: spec.language,
        code: deliverable.code,
        stdin: test.stdin,
        limits: { timeoutMs: spec.timeoutMs },
        backend,
      });
    } catch (err) {
      tests.push({
        name: test.name,
        passed: false,
        reasons: [`sandbox error: ${err.message}`],
        durationMs: 0,
      });
      continue;
    }

    const { passed, reasons } = judge(test, result);
    tests.push({
      name: test.name,
      passed,
      reasons,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      // Keep a bounded excerpt so a dispute can be examined without the
      // receipt becoming unbounded.
      stdout: result.stdout.slice(0, 2000),
      stderr: result.stderr.slice(0, 2000),
    });
  }

  const passedCount = tests.filter((t) => t.passed).length;
  return {
    tests,
    passedCount,
    total: tests.length,
    score: tests.length === 0 ? 0 : Math.round((passedCount / tests.length) * 100),
  };
}

/**
 * The whole evaluation: resolve, verify commitments, run, and build a verdict.
 *
 * Never throws for an outcome the protocol anticipates — a broken deliverable
 * is an `abstain`, not an exception.
 */
export async function evaluate({
  specUri,
  specHash,
  deliverableUri,
  deliverableHash,
  jobId = null,
  agentId = null,
  backend,
  resolveOpts,
  evaluator,
  isolatedRequired = false,
}) {
  const base = {
    spec: VERDICT_VERSION,
    jobId,
    agentId,
    specHash,
    deliverableHash,
    evaluator: evaluator ?? null,
    evaluatedAt: new Date().toISOString(),
  };

  const abstain = (reason, code) => ({
    ...base,
    outcome: OUTCOME.ABSTAIN,
    score: 0,
    reason,
    code,
    tests: [],
  });

  // --- resolve and verify the spec ---------------------------------------
  let specDoc;
  try {
    specDoc = await resolve(specUri, resolveOpts);
  } catch (err) {
    return abstain(`could not fetch the job spec: ${err.message}`, "spec_unavailable");
  }
  if (!matchesCommitment(specDoc, specHash)) {
    return abstain(
      `job spec at ${specUri} hashes to ${hashDocument(specDoc)}, but the job committed to ${specHash}`,
      "spec_hash_mismatch",
    );
  }

  let spec;
  try {
    spec = parseJobSpec(specDoc);
  } catch (err) {
    return abstain(`job spec is unusable: ${err.message}`, err.code ?? "bad_spec");
  }

  // --- resolve and verify the deliverable ---------------------------------
  if (!deliverableUri) {
    return abstain("the submission carried no deliverable uri", "deliverable_uri_missing");
  }

  let deliverableDoc;
  try {
    deliverableDoc = await resolve(deliverableUri, resolveOpts);
  } catch (err) {
    return abstain(`could not fetch the deliverable: ${err.message}`, "deliverable_unavailable");
  }
  if (!matchesCommitment(deliverableDoc, deliverableHash)) {
    // The single most important check here: what was served is not what was
    // committed to on-chain, so it is not the submission.
    return abstain(
      `deliverable at ${deliverableUri} hashes to ${hashDocument(deliverableDoc)}, but the provider committed to ${deliverableHash}`,
      "deliverable_hash_mismatch",
    );
  }

  let work;
  try {
    work = parseDeliverable(deliverableDoc);
  } catch (err) {
    // A malformed deliverable is the provider's failure, not an ambiguity.
    return {
      ...base,
      outcome: OUTCOME.FAILED,
      score: 0,
      reason: err.message,
      code: err.code ?? "bad_deliverable",
      tests: [],
    };
  }

  // --- run ----------------------------------------------------------------
  const { tests, passedCount, total, score } = await runTests({ spec, deliverable: work, backend });

  if (isolatedRequired && tests.some((t) => t.isolated === false)) {
    return abstain("sandbox isolation was required but unavailable", "isolation_unavailable");
  }

  return {
    ...base,
    outcome: passedCount === total ? OUTCOME.PASSED : OUTCOME.FAILED,
    score,
    reason: `${passedCount}/${total} tests passed`,
    tests,
    language: spec.language,
  };
}

/** Hash a verdict for on-chain reference, and optionally sign it. */
export async function sealVerdict(verdict, wallet) {
  const hash = hashDocument(verdict);
  if (!wallet) return { verdict, hash, signature: null };

  const signature = await wallet.signMessage({
    account: wallet.account,
    message: { raw: hash },
  });
  return { verdict, hash, signature };
}

export { canonicalize, hashDocument, SpecError };

export class ResolveError extends Error {
  constructor(message, uri) {
    super(message);
    this.uri = uri;
  }
}
