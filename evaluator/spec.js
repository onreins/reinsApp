/**
 * The Verdict protocol: what "correct" means, agreed before work starts.
 *
 * ERC-8183 gives us a `description` string on the job and a `bytes32`
 * deliverable commitment. Neither says anything about how to decide whether
 * the work is good. This layer fills that in:
 *
 *   1. The client publishes a **job spec** — the tests the work must pass —
 *      and names it in the job description by URI and hash.
 *   2. The provider publishes a **deliverable** and commits its hash on-chain
 *      via `submit()`.
 *   3. The evaluator fetches both, checks each against its committed hash,
 *      runs the tests, and publishes a signed **verdict**.
 *
 * Everything is content-addressed. That is the load-bearing property: a hash
 * committed on-chain before evaluation means neither party can swap the
 * content afterwards and argue about what was really submitted. If what we
 * fetch does not hash to what was committed, we refuse to judge rather than
 * guess.
 */
import { keccak256, toBytes, toHex, hexToString, stringToHex } from "viem";

export const SPEC_VERSION = "verdict/1";
export const DELIVERABLE_VERSION = "verdict-deliverable/1";
export const VERDICT_VERSION = "verdict-result/1";

/** Languages the sandbox can judge. */
const LANGUAGES = new Set(["python", "javascript"]);

/**
 * Deterministic serialisation. Object keys are sorted at every level so the
 * same document always produces the same bytes, and therefore the same hash,
 * regardless of who serialised it or in what order the fields were built.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/** keccak256 of the canonical form — the value committed on-chain. */
export function hashDocument(doc) {
  return keccak256(toBytes(canonicalize(doc)));
}

/** True when `doc` matches a commitment made on-chain. */
export function matchesCommitment(doc, committedHash) {
  return hashDocument(doc).toLowerCase() === String(committedHash).toLowerCase();
}

// ---------------------------------------------------------------------------
// Job description: how a job points at its spec
// ---------------------------------------------------------------------------

/** Encode the pointer that goes in ERC-8183's `description` field. */
export function encodeJobDescription({ uri, hash, summary }) {
  return canonicalize({ spec: SPEC_VERSION, uri, hash, summary });
}

export function parseJobDescription(description) {
  let parsed;
  try {
    parsed = JSON.parse(description);
  } catch {
    throw new SpecError("job description is not valid JSON", "unparseable_description");
  }
  if (parsed?.spec !== SPEC_VERSION) {
    throw new SpecError(
      `unsupported job spec "${parsed?.spec}" (this evaluator speaks ${SPEC_VERSION})`,
      "unsupported_spec",
    );
  }
  if (typeof parsed.uri !== "string" || !parsed.uri) {
    throw new SpecError("job description has no spec uri", "missing_uri");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.hash ?? "")) {
    throw new SpecError("job description has no valid spec hash", "missing_hash");
  }
  return { uri: parsed.uri, hash: parsed.hash, summary: parsed.summary };
}

/** ERC-8183 `optParams` is free-form bytes; we carry the deliverable URI there. */
export const encodeDeliverableUri = (uri) => stringToHex(uri);
export const decodeDeliverableUri = (data) => {
  if (!data || data === "0x") return null;
  try {
    const uri = hexToString(data);
    return uri && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) ? uri : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a job spec. Throws rather than repairing: an ambiguous spec is a
 * dispute waiting to happen, and the evaluator's only job is to be predictable.
 */
export function parseJobSpec(doc) {
  if (doc?.spec !== SPEC_VERSION) {
    throw new SpecError(`unsupported spec "${doc?.spec}"`, "unsupported_spec");
  }
  if (!LANGUAGES.has(doc.language)) {
    throw new SpecError(
      `unsupported language "${doc.language}" (have: ${[...LANGUAGES].join(", ")})`,
      "unsupported_language",
    );
  }
  if (!Array.isArray(doc.tests) || doc.tests.length === 0) {
    throw new SpecError("spec must contain at least one test", "no_tests");
  }
  if (doc.tests.length > 100) {
    throw new SpecError("spec contains more than 100 tests", "too_many_tests");
  }

  const timeoutMs = Number.isFinite(doc.timeoutMs) ? Math.min(doc.timeoutMs, 30_000) : 10_000;

  const tests = doc.tests.map((t, i) => {
    if (typeof t?.name !== "string" || !t.name) {
      throw new SpecError(`test ${i} has no name`, "bad_test");
    }
    const expect = t.expect ?? {};
    const hasAssertion =
      typeof expect.stdout === "string" ||
      typeof expect.stdoutContains === "string" ||
      Number.isInteger(expect.exitCode);
    if (!hasAssertion) {
      throw new SpecError(`test "${t.name}" asserts nothing`, "bad_test");
    }
    return {
      name: t.name,
      stdin: typeof t.stdin === "string" ? t.stdin : "",
      expect: {
        stdout: typeof expect.stdout === "string" ? expect.stdout : undefined,
        stdoutContains:
          typeof expect.stdoutContains === "string" ? expect.stdoutContains : undefined,
        exitCode: Number.isInteger(expect.exitCode) ? expect.exitCode : undefined,
      },
    };
  });

  return { spec: SPEC_VERSION, language: doc.language, timeoutMs, tests };
}

export function parseDeliverable(doc) {
  if (doc?.spec !== DELIVERABLE_VERSION) {
    throw new SpecError(`unsupported deliverable "${doc?.spec}"`, "unsupported_deliverable");
  }
  if (typeof doc.code !== "string" || doc.code.length === 0) {
    throw new SpecError("deliverable contains no code", "empty_deliverable");
  }
  if (doc.code.length > 512 * 1024) {
    throw new SpecError("deliverable exceeds 512KB", "deliverable_too_large");
  }
  return { spec: DELIVERABLE_VERSION, code: doc.code };
}

/** Build the documents a client and provider publish. */
export const jobSpec = ({ language, tests, timeoutMs = 10_000 }) =>
  parseJobSpec({ spec: SPEC_VERSION, language, timeoutMs, tests });

export const deliverable = (code) => parseDeliverable({ spec: DELIVERABLE_VERSION, code });

export class SpecError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export { toHex };
