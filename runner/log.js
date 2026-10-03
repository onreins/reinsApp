/**
 * The runner's only way to print. Everything passes through redact(), so a
 * private key, a bearer token or a long secret can't reach a log by accident,
 * and neither can the exact secret values the runner was started with
 * (setSecrets). Addresses and transaction hashes stay readable: they're public
 * and they're what you need when something goes wrong.
 */
const PRIVATE_KEY = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const LONG_HEX = /0x[0-9a-fA-F]{65,}/g;
const BEARER = /(Bearer\s+)\S+/gi;
const LONG_SECRET = /\b[A-Za-z0-9_\-]{32,}\b/g;
let secrets = [];

/** The exact values to scrub (the master key, the shared secret, the gas key, an RPC URL with a token). */
export function setSecrets(values) {
  secrets = values.filter((v) => typeof v === "string" && v.length >= 8).sort((a, b) => b.length - a.length);
}

/**
 * A transaction hash and a private key look the same (0x + 64 hex), so the
 * runner never logs a key, and hashes are logged through `tx()` below instead.
 */
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out
    .replace(BEARER, "$1[redacted]")
    .replace(LONG_HEX, "0x[redacted]")
    .replace(PRIVATE_KEY, "0x[redacted]")
    // 0x values are addresses or hashes here: keys were already caught above.
    .replace(LONG_SECRET, (m) => (m.startsWith("0x") ? m : "[redacted]"));
}

/** A transaction hash shortened for logs: enough to find it on the explorer. */
export const tx = (hash) => (typeof hash === "string" ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : String(hash));

const show = (p) => {
  if (p instanceof Error) return p.stack || p.message;
  if (typeof p === "string") return p;
  try {
    return JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? "[bytes]" : v));
  } catch {
    return String(p);
  }
};

const write = (level, parts) => {
  const out = `${new Date().toISOString()} ${level} ${redact(parts.map(show).join(" "))}`;
  if (level === "error") console.error(out);
  else console.log(out);
};

export const log = {
  info: (...parts) => write("info", parts),
  warn: (...parts) => write("warn", parts),
  error: (...parts) => write("error", parts),
};
