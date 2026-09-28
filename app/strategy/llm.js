/**
 * A small client for any OpenAI-compatible chat endpoint: FreeLLMAPI in
 * front of free tiers, or a provider directly (Groq, Cloudflare, ...).
 *
 *   LLM_BASE_URL   e.g. http://127.0.0.1:3001/v1 (FreeLLMAPI) or https://api.groq.com/openai/v1
 *   LLM_API_KEY    the endpoint's key (FreeLLMAPI's unified key, or the provider's)
 *   LLM_MODEL      "auto" for FreeLLMAPI's router, or a model id
 *
 * Without LLM_BASE_URL the chat runs on its offline builder.
 */
const TIMEOUT_MS = 25_000;

export function createLlm({
  baseUrl = process.env.LLM_BASE_URL,
  apiKey = process.env.LLM_API_KEY,
  model = process.env.LLM_MODEL || "auto",
  timeoutMs = TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = baseUrl ? baseUrl.replace(/\/+$/, "") + "/chat/completions" : null;
  const client = {
    connected: Boolean(url),
    name: model,

    /** Send the conversation; resolves to { text, route }. Throws on any failure. */
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
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 400 && json) continue;
        if (!res.ok) throw new Error(`model endpoint answered ${res.status}`);
        const body = await res.json();
        const text = body?.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new Error("model endpoint sent no text");
        // Returned, not stored: the client is shared, and concurrent chats must not see each other's route.
        return { text, route: res.headers.get("x-routed-via") || body.model || model };
      }
      throw new Error("model endpoint refused the request");
    },
  };
  return client;
}
