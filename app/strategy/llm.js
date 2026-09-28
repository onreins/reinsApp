/**
 * Clients for OpenAI-compatible chat endpoints (Cloudflare Workers AI, Groq,
 * Gemini's OpenAI endpoint, FreeLLMAPI, ...), and a chain that rotates between
 * them: when one is rate limited, out of its daily quota, down, or refuses its
 * key, the same request goes to the next, and the one that failed rests until
 * it's allowed again.
 *
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL      the main provider
 *   LLM_FALLBACK_MODELS                        more models on that endpoint, comma-separated
 *   LLM2_BASE_URL, LLM2_API_KEY, LLM2_MODEL    the next provider; then LLM3_, LLM4_...
 *
 * Without LLM_BASE_URL the chat runs on its offline builder.
 */
const TIMEOUT_MS = 25_000;

/** A failed call, with what kind of failure it was, so the chain knows how long to rest. */
export class LlmError extends Error {
  constructor(message, { status = null, kind = "down", retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // "limit" | "quota" | "auth" | "down"
    this.retryAfter = retryAfter; // seconds, when the provider said
  }
}

const QUOTA = /daily|per day|quota|allocation|neurons|exhausted|credits?/i;

function classify(status, detail) {
  if (QUOTA.test(detail) && (status === 429 || status === 402 || status === 403 || status >= 400)) return "quota";
  if (status === 429) return "limit";
  if (status === 401 || status === 403) return "auth";
  return "down";
}

function retryAfterOf(res) {
  const v = res.headers?.get?.("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

async function detailOf(res) {
  try {
    if (typeof res.text === "function") return (await res.text()).slice(0, 300);
    return JSON.stringify(await res.json()).slice(0, 300);
  } catch {
    return "";
  }
}

export function createLlm({
  baseUrl = process.env.LLM_BASE_URL,
  apiKey = process.env.LLM_API_KEY,
  model = process.env.LLM_MODEL || "auto",
  timeoutMs = TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = baseUrl ? baseUrl.replace(/\/+$/, "") + "/chat/completions" : null;
  return {
    connected: Boolean(url),
    name: model,

    /** Send the conversation; resolves to { text, route, usage }. Throws an LlmError on any failure. */
    async complete(messages) {
      if (!url) throw new Error("no model configured");
      // Ask for JSON; if a provider rejects that option, ask once more without it.
      for (const json of [true, false]) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res;
        try {
          res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 900, ...(json ? { response_format: { type: "json_object" } } : {}) }),
            signal: ctl.signal,
          });
        } catch (err) {
          throw new LlmError(err?.message || "network error", { kind: "down" });
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 400 && json) continue;
        if (!res.ok) {
          const detail = await detailOf(res);
          throw new LlmError(`model endpoint answered ${res.status}`, { status: res.status, kind: classify(res.status, detail), retryAfter: retryAfterOf(res) });
        }
        const body = await res.json();
        const text = body?.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new LlmError("model endpoint sent no text", { kind: "down" });
        const usage = body.usage ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 } : null;
        // Returned, not stored: the client is shared, and concurrent chats must not see each other's route.
        return { text, route: res.headers.get("x-routed-via") || body.model || model, usage };
      }
      throw new LlmError("model endpoint refused the request", { status: 400, kind: "down" });
    },
  };
}

/**
 * Try `clients` in order, skipping any that is resting. A limit rests for as
 * long as the provider said (a minute if it didn't), a spent daily quota until
 * midnight UTC, a refused key for an hour, an outage for 20 seconds.
 */
export function createLlmChain(clients, { now = () => Date.now(), log = (m) => console.warn(m) } = {}) {
  const state = clients.map((c) => ({ c, until: 0, day: null, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0 }));
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const roll = (s) => {
    const d = today();
    if (s.day !== d) Object.assign(s, { day: d, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0 });
  };
  const midnight = () => {
    const d = new Date(now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  };
  const restUntil = (e) => {
    switch (e.kind) {
      case "quota": return midnight();
      case "limit": return now() + Math.min(e.retryAfter ?? 60, 86_400) * 1000;
      case "auth": return now() + 3_600_000;
      default: return now() + 20_000;
    }
  };
  const available = (s) => now() >= s.until;

  return {
    connected: clients.some((c) => c.connected),
    /** The provider the next request goes to first. */
    get name() {
      return (state.find(available) ?? state[0])?.c.name ?? null;
    },

    async complete(messages) {
      if (!state.length) throw new Error("no model configured");
      let last = null;
      for (const s of state) {
        if (!available(s)) continue;
        roll(s);
        s.calls += 1;
        try {
          const r = await s.c.complete(messages);
          if (r.usage) { s.tokensIn += r.usage.input; s.tokensOut += r.usage.output; }
          return r;
        } catch (e) {
          s.failures += 1;
          s.until = restUntil(e);
          last = e;
          log(`[llm] ${s.c.name}: ${e.message} (${e.kind ?? "error"}); resting until ${new Date(s.until).toISOString()}`);
        }
      }
      throw last ?? new Error("every model is resting after hitting its limit");
    },

    /** Today's use per provider (UTC day), and whether each is available right now. */
    stats() {
      return state.map((s) => {
        roll(s);
        return { name: s.c.name, available: available(s), until: s.until > now() ? new Date(s.until).toISOString() : null, calls: s.calls, failures: s.failures, tokensIn: s.tokensIn, tokensOut: s.tokensOut };
      });
    },
  };
}

/** The providers configured in `env`, in the order they're tried. */
export function providersFromEnv(env = process.env) {
  const list = [];
  if (env.LLM_BASE_URL) {
    const main = { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || "auto" };
    list.push(main);
    for (const m of (env.LLM_FALLBACK_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean)) list.push({ ...main, model: m });
  }
  for (let i = 2; env[`LLM${i}_BASE_URL`]; i++) {
    list.push({ baseUrl: env[`LLM${i}_BASE_URL`], apiKey: env[`LLM${i}_API_KEY`], model: env[`LLM${i}_MODEL`] || "auto" });
  }
  return list;
}

/** The chain the server uses: every configured provider, in order. */
export function createLlmFromEnv(env = process.env, opts = {}) {
  return createLlmChain(providersFromEnv(env).map((p) => createLlm({ ...p, ...opts })));
}
