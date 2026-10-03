/**
 * The runner's settings, read once from the environment. Anything missing or
 * malformed stops startup with every problem listed, and never echoes a secret.
 *
 *   RUNNER_MASTER_KEY   32 random bytes as 64 hex characters; encrypts every trading key
 *   RUNNER_SECRET       shared with the app server; at least 32 characters
 *   GAS_WALLET_KEY      0x + 64 hex: pays the trading keys' gas
 *   APP_RPC             optional RPC URL (defaults to the chain's public one)
 *   RUNNER_NETWORK      testnet (default) or mainnet
 *   TICK_SECONDS        how often each agent is looked at; 60–3600, default 300
 *   KILL_SWITCH_FILE    if this file exists, nothing is sent (default data/STOP)
 *   RUNNER_DB           SQLite file (default data/runner.sqlite)
 *   RUNNER_HOST         where /health listens (default 127.0.0.1: this machine only)
 *   RUNNER_PORT         the small HTTP API (default 4400)
 *
 * Relative paths resolve from the repository, not from wherever the process was
 * started, so a different working directory can't quietly open an empty
 * database (and lose every sealed key with it).
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEX32 = /^[0-9a-fA-F]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const MIN_SECRET = 32;
const TICK = { min: 60, max: 3600, fallback: 300 };
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const inRepo = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));
// A master key of one repeated byte (all zeros, say) is a placeholder, not a key.
const weak = (hex) => new Set(hex.toLowerCase().match(/../g)).size < 8;
const validUrl = (u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

export function loadConfig(env = process.env) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };

  const master = env.RUNNER_MASTER_KEY ?? "";
  need(HEX32.test(master), "RUNNER_MASTER_KEY must be 64 hex characters (32 bytes)");
  need(!HEX32.test(master) || !weak(master), "RUNNER_MASTER_KEY looks like a placeholder; generate random bytes");
  need((env.RUNNER_SECRET ?? "").length >= MIN_SECRET, `RUNNER_SECRET must be at least ${MIN_SECRET} characters`);
  need(PRIVATE_KEY.test(env.GAS_WALLET_KEY ?? ""), "GAS_WALLET_KEY must be 0x followed by 64 hex characters");
  need(!env.APP_RPC || validUrl(env.APP_RPC), "APP_RPC must be an http(s) URL");

  const tick = env.TICK_SECONDS === undefined ? TICK.fallback : Number(env.TICK_SECONDS);
  need(Number.isInteger(tick) && tick >= TICK.min && tick <= TICK.max, `TICK_SECONDS must be a whole number from ${TICK.min} to ${TICK.max}`);

  const network = env.RUNNER_NETWORK ?? "testnet";
  need(network === "testnet" || network === "mainnet", "RUNNER_NETWORK must be testnet or mainnet");

  const port = env.RUNNER_PORT === undefined ? 4400 : Number(env.RUNNER_PORT);
  need(Number.isInteger(port) && port > 0 && port < 65536, "RUNNER_PORT must be a port number");

  if (problems.length) throw new Error("runner can't start:\n  - " + problems.join("\n  - "));

  return Object.freeze({
    masterKey: Buffer.from(master, "hex"),
    secret: env.RUNNER_SECRET,
    gasKey: env.GAS_WALLET_KEY,
    rpcUrl: env.APP_RPC || undefined,
    network,
    tickSeconds: tick,
    killSwitchFile: inRepo(env.KILL_SWITCH_FILE || "data/STOP"),
    dbPath: inRepo(env.RUNNER_DB || "data/runner.sqlite"),
    host: env.RUNNER_HOST || "127.0.0.1",
    port,
  });
}
