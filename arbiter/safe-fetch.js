/**
 * A fetch for URLs chosen by strangers.
 *
 * The arbiter is a public service that fetches whatever terms and delivery URLs
 * a caller hands it. Without care that is a server-side request forgery hole:
 * point it at http://169.254.169.254/ or an internal admin page and the
 * arbiter fetches it on your behalf. So this fetch:
 *
 *   - allows only http and https
 *   - resolves the host and refuses loopback, private, link-local, CGNAT,
 *     multicast and reserved addresses (IPv4 and IPv6, including mapped forms)
 *   - follows at most a few redirects, re-checking every hop
 *   - streams the body and aborts past a byte ceiling, instead of reading an
 *     unbounded response into memory first
 *
 * Known limit: the address check and the connection are separate DNS lookups,
 * so a hostile resolver could rebind between them. Closing that needs a pinned
 * connection (a custom undici dispatcher), which is the next step before this
 * faces the open internet at scale.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.code = "unsafe_url";
  }
}

/** True for any IPv4 address a public service has no business fetching. */
function isBlockedV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * Expand an IPv6 address into its eight 16-bit groups, or null if malformed.
 *
 * Classifying by string prefix is not safe: the URL parser rewrites
 * [::ffff:169.254.169.254] as ::ffff:a9fe:a9fe, so any check has to work on the
 * numeric value, whatever notation the attacker chose.
 */
function parseV6(ip) {
  let text = ip.toLowerCase().split("%")[0];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

const embeddedV4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isBlockedV6(ip) {
  const g = parseV6(ip);
  if (!g) return true;
  const zeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);

  if (zeroUpTo(8)) return true; // ::
  if (zeroUpTo(7) && g[7] === 1) return true; // ::1
  if (zeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return isBlockedV4(embeddedV4(g[6], g[7])); // ::a.b.c.d (IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4(embeddedV4(g[6], g[7])); // NAT64
  }
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnels an obfuscated IPv4
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && zeroUpTo(4)) return true; // discard
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link/site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isBlockedAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

/** Throw unless every address the host resolves to is public. */
export async function assertPublicUrl(raw, { lookup = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`scheme ${url.protocol} is not allowed`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new UnsafeUrlError("host did not resolve");
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new UnsafeUrlError("host resolves to a non-public address");
    }
  }
  return url;
}

/** Read a response body as text, aborting as soon as it passes `maxBytes`. */
async function readCapped(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`document exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A fetch-compatible function for `resolve()`.
 *
 * Returns a minimal Response-like object ({ ok, status, text }) so it drops
 * into the evaluator's resolve() unchanged.
 */
export function createSafeFetch({
  maxBytes = 1024 * 1024,
  allowPrivate = false,
  lookup = dnsLookup,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function safeFetch(target, init = {}) {
    let current = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowPrivate) await assertPublicUrl(current, { lookup });
      const res = await fetchImpl(current, { ...init, redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      const text = res.ok ? await readCapped(res, maxBytes) : "";
      return { ok: res.ok, status: res.status, text: async () => text };
    }
    throw new UnsafeUrlError(`more than ${MAX_REDIRECTS} redirects`);
  };
}
