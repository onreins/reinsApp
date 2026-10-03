/**
 * The runner's foundations: settings it refuses to start without, logs that
 * never carry a key, and trading keys that are only ever stored encrypted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, sep } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../runner/config.js";
import { redact, setSecrets } from "../runner/log.js";
import { createKeystore } from "../runner/keystore.js";

const MASTER = "0123456789abcdeffedcba98765432100f1e2d3c4b5a69788796a5b4c3d2e1f0";
const GAS = "0x" + "22".repeat(32);
const good = { RUNNER_MASTER_KEY: MASTER, RUNNER_SECRET: "s".repeat(32), GAS_WALLET_KEY: GAS };

describe("config", () => {
  test("reads a good environment, with defaults", () => {
    const c = loadConfig(good);
    assert.equal(c.masterKey.length, 32);
    assert.equal(c.tickSeconds, 300);
    assert.equal(c.network, "testnet");
    assert.equal(c.port, 4400);
    assert.equal(c.host, "127.0.0.1", "health is for this machine unless told otherwise");
    assert.ok(isAbsolute(c.dbPath) && c.dbPath.split(sep).join("/").endsWith("/data/runner.sqlite"), "paths resolve from the repo, not the working directory");
  });

  test("refuses a placeholder master key", () => {
    assert.throws(() => loadConfig({ ...good, RUNNER_MASTER_KEY: "00".repeat(32) }), /placeholder/);
  });

  test("refuses an RPC that isn't a URL", () => {
    assert.throws(() => loadConfig({ ...good, APP_RPC: "not a url" }), /APP_RPC/);
  });

  test("refuses to start, naming every problem at once", () => {
    assert.throws(
      () => loadConfig({ RUNNER_MASTER_KEY: "abc", RUNNER_SECRET: "short", TICK_SECONDS: "5" }),
      (err) => /RUNNER_MASTER_KEY/.test(err.message) && /RUNNER_SECRET/.test(err.message) && /GAS_WALLET_KEY/.test(err.message) && /TICK_SECONDS/.test(err.message),
    );
  });

  test("its error message never repeats a secret it was given", () => {
    try {
      loadConfig({ ...good, GAS_WALLET_KEY: "0x" + "ab".repeat(31) });
      assert.fail("should refuse a short key");
    } catch (err) {
      assert.ok(!err.message.includes("ab".repeat(31)));
    }
  });
});

describe("log redaction", () => {
  test("hides private keys, long secrets and bearer tokens", () => {
    const key = "0x" + "9f".repeat(32);
    const out = redact(`key ${key} and Authorization: Bearer ${"t".repeat(40)}`);
    assert.ok(!out.includes("9f".repeat(32)));
    assert.ok(!out.includes("t".repeat(40)));
  });

  test("hides the exact secrets it was started with, whatever their shape", () => {
    setSecrets(["https://rpc.example/key-abc123", "shortsecret99"]);
    const out = redact("calling https://rpc.example/key-abc123 with shortsecret99");
    assert.ok(!out.includes("key-abc123") && !out.includes("shortsecret99"));
    setSecrets([]);
  });

  test("leaves addresses and transaction hashes readable", () => {
    const addr = "0x" + "ab".repeat(20);
    assert.equal(redact(`agent ${addr}`), `agent ${addr}`);
  });
});

describe("keystore", () => {
  const ks = createKeystore({ masterKey: Buffer.from(MASTER, "hex") });

  test("a new key opens to the address it was issued for", () => {
    const { address, sealed } = ks.generate();
    assert.equal(ks.account(sealed, address).address, address);
  });

  test("what is stored never contains the key in the clear", () => {
    const { address, sealed } = ks.generate();
    const key = ks.open(sealed, address);
    assert.equal(privateKeyToAccount(key).address.length, 42);
    assert.ok(!JSON.stringify(sealed).includes(key.slice(2)));
  });

  test("a different master key cannot open it", () => {
    const { address, sealed } = ks.generate();
    const other = createKeystore({ masterKey: Buffer.from("33".repeat(32), "hex") });
    assert.throws(() => other.open(sealed, address));
  });

  test("a tampered key fails rather than opening to something else", () => {
    const { address, sealed } = ks.generate();
    const flipped = sealed.enc.slice(0, -2) + (sealed.enc.endsWith("00") ? "01" : "00");
    assert.throws(() => ks.open({ ...sealed, enc: flipped }, address));
  });

  test("a sealed key moved onto another address's row won't open", () => {
    const a = ks.generate(), b = ks.generate();
    assert.throws(() => ks.open(a.sealed, b.address));
    assert.throws(() => ks.account(a.sealed, b.address));
  });

  test("two keys never share an IV", () => {
    assert.notEqual(ks.generate().sealed.iv, ks.generate().sealed.iv);
  });

  test("refuses a master key that isn't 32 bytes", () => {
    assert.throws(() => createKeystore({ masterKey: Buffer.alloc(16) }));
  });
});
