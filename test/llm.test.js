/**
 * Rotating between free model providers: when one is rate limited, out of its
 * daily quota, down, or refuses the key, the same request goes to the next one,
 * and the one that failed rests until it's allowed again.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createLlm, createLlmChain, providersFromEnv } from "../app/strategy/llm.js";

const reply = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers(headers) });
const ok = (text, usage) => reply(200, { choices: [{ message: { content: text } }], ...(usage ? { usage } : {}) });

/** A provider whose answers are scripted, one per call. */
function scripted(name, answers) {
  const calls = [];
  const client = createLlm({
    baseUrl: `http://${name}/v1`, model: name,
    fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
  });
  return { client, calls };
}

describe("one provider's errors", () => {
  test("say what went wrong: a limit, with how long to wait", async () => {
    const { client } = scripted("a", [reply(429, { error: "slow down" }, { "retry-after": "30" })]);
    await assert.rejects(client.complete([]), (e) => e.status === 429 && e.kind === "limit" && e.retryAfter === 30 && /429/.test(e.message));
  });

  test("a daily quota, a bad key, and an outage are told apart", async () => {
    const q = scripted("a", [reply(429, { errors: [{ message: "You have used up your daily free allocation of 10,000 neurons" }] })]);
    await assert.rejects(q.client.complete([]), (e) => e.kind === "quota");
    const k = scripted("b", [reply(401, { error: "bad key" })]);
    await assert.rejects(k.client.complete([]), (e) => e.kind === "auth");
    const d = scripted("c", [reply(503, {})]);
    await assert.rejects(d.client.complete([]), (e) => e.kind === "down");
  });
});

describe("the rotation", () => {
  test("moves on to the next provider when one is limited, and uses it again once it may", async () => {
    let t = Date.UTC(2026, 8, 28, 12);
    const a = scripted("a", [reply(429, {}, { "retry-after": "60" }), ok("from a again")]);
    const b = scripted("b", [ok("from b"), ok("from b twice")]);
    const chain = createLlmChain([a.client, b.client], { now: () => t });
    assert.equal((await chain.complete([])).text, "from b");
    // Still resting: straight to b, without asking a.
    assert.equal((await chain.complete([])).text, "from b twice");
    assert.equal(a.calls.length, 1);
    t += 61_000;
    assert.equal((await chain.complete([])).text, "from a again");
  });

  test("a spent daily quota rests until midnight UTC", async () => {
    let t = Date.UTC(2026, 8, 28, 22);
    const a = scripted("a", [reply(429, { error: "daily quota exceeded" }), ok("a is back")]);
    const b = scripted("b", [ok("b"), ok("b"), ok("b")]);
    const chain = createLlmChain([a.client, b.client], { now: () => t });
    await chain.complete([]);
    t = Date.UTC(2026, 8, 28, 23, 59);
    assert.equal((await chain.complete([])).text, "b");
    t = Date.UTC(2026, 8, 29, 0, 1);
    assert.equal((await chain.complete([])).text, "a is back");
  });

  test("an outage or a timeout also moves on", async () => {
    const a = scripted("a", [new Error("aborted")]);
    const b = scripted("b", [reply(502, {})]);
    const c = scripted("c", [ok("from c")]);
    const chain = createLlmChain([a.client, b.client, c.client]);
    const r = await chain.complete([]);
    assert.equal(r.text, "from c");
    assert.equal(r.route, "c");
  });

  test("with every provider out it throws, so the chat can use its simple builder", async () => {
    const a = scripted("a", [reply(429, {})]);
    const b = scripted("b", [reply(429, {})]);
    const chain = createLlmChain([a.client, b.client]);
    await assert.rejects(chain.complete([]), /429/);
    // Both resting now: it says so without calling anyone.
    await assert.rejects(chain.complete([]), /resting/);
    assert.equal(a.calls.length + b.calls.length, 2);
  });

  test("names the first provider that's available, and counts today's use", async () => {
    let t = Date.UTC(2026, 8, 28, 12);
    const a = scripted("a", [reply(429, {}, { "retry-after": "600" })]);
    const b = scripted("b", [ok("x", { prompt_tokens: 1200, completion_tokens: 150 })]);
    const chain = createLlmChain([a.client, b.client], { now: () => t });
    assert.equal(chain.name, "a");
    await chain.complete([]);
    assert.equal(chain.name, "b");
    const [sa, sb] = chain.stats();
    assert.deepEqual([sa.name, sa.available, sa.calls, sa.failures], ["a", false, 1, 1]);
    assert.deepEqual([sb.calls, sb.tokensIn, sb.tokensOut], [1, 1200, 150]);
    // A new UTC day starts the counts over.
    t = Date.UTC(2026, 8, 29, 1);
    assert.equal(chain.stats()[1].calls, 0);
  });
});

describe("providers from the environment", () => {
  test("reads the main one, backup models on the same endpoint, then LLM2_, LLM3_...", () => {
    const list = providersFromEnv({
      LLM_BASE_URL: "https://cf/v1", LLM_API_KEY: "k1", LLM_MODEL: "big",
      LLM_FALLBACK_MODELS: "small, tiny",
      LLM2_BASE_URL: "https://g/v1", LLM2_API_KEY: "k2", LLM2_MODEL: "gem",
      LLM4_BASE_URL: "https://skipped-because-3-is-missing/v1",
    });
    assert.deepEqual(list.map((p) => [p.baseUrl, p.model, p.apiKey]), [
      ["https://cf/v1", "big", "k1"], ["https://cf/v1", "small", "k1"], ["https://cf/v1", "tiny", "k1"], ["https://g/v1", "gem", "k2"],
    ]);
    assert.deepEqual(providersFromEnv({}), []);
  });
});
