/**
 * Card funding: people buy USDC on Arc with a debit card, Apple Pay or Google
 * Pay without leaving the app, through Circle's Onramp Kit.
 *
 *   GET  /api/onramp/status    { enabled, environment, widgetBaseUrl } (or { enabled: false })
 *   POST /api/onramp/session   { address } -> a short-lived widget session
 *
 * The API key stays on the server; the browser only ever gets a session that
 * lasts 30 minutes and pays into the wallet it names. The USDC lands in the
 * person's own wallet, and the create flow's usual deposit step moves it into
 * their agent, so nothing here holds or routes money.
 *
 *   ONRAMP_API_KEY          from the Circle Console, exactly as issued (server only)
 *   ONRAMP_ENV              "sandbox" (default, no real money) or "production"
 *   ONRAMP_REFERRER_DOMAIN  the bare hostname the app is served from, e.g. onreins-app.vercel.app
 */
import { createOnrampServerKit } from "@circle-fin/onramp-kit/server";
import { isAddress } from "viem";

import { createLimiter } from "./strategy/routes.js";

const HOSTS = {
  sandbox: { baseUrl: "https://api-test.circle.com", widgetBaseUrl: "https://onramp-sandbox.arc.io" },
  production: { baseUrl: "https://api.circle.com", widgetBaseUrl: "https://onramp.arc.io" },
};
// Circle wants a bare hostname: no scheme, port, path or wildcard.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** The onramp settings in `env`; off without a key, sandbox unless told otherwise. */
export function onrampConfig(env = process.env) {
  const apiKey = env.ONRAMP_API_KEY || "";
  const environment = env.ONRAMP_ENV === "production" ? "production" : "sandbox";
  const ref = env.ONRAMP_REFERRER_DOMAIN;
  return { enabled: Boolean(apiKey), apiKey, environment, ...HOSTS[environment], referrerDomain: ref && HOSTNAME.test(ref) ? ref : undefined };
}

// Circle's errors carry a stable `type`. Matched by shape, because the kit's
// server and browser entry points are separate bundles with separate classes.
const STATUS = { INPUT: 400, RATE_LIMIT: 429, NETWORK: 504, SERVICE: 502, RPC: 502 };
const MESSAGE = {
  INPUT: "Circle refused that checkout. Check the wallet address and try again.",
  RATE_LIMIT: "Circle's checkout is busy right now. Try again in a minute.",
  NETWORK: "Couldn't reach Circle's checkout. Try again in a moment.",
  SERVICE: "Circle's checkout is having trouble. Try again shortly.",
  RPC: "Circle's checkout is having trouble. Try again shortly.",
};
const isKitError = (e) => Boolean(e) && typeof e.type === "string" && typeof e.recoverability === "string";

/**
 * @param {import("express").Express} app
 * @param {object} [o]  { env } to read settings from, or { kit, environment,
 *                      widgetBaseUrl } to use a ready kit (tests); { perVisitor } limiter
 */
export function mountOnramp(app, o = {}) {
  let kit = o.kit ?? null, environment = o.environment, widgetBaseUrl = o.widgetBaseUrl;
  if (!kit) {
    const c = onrampConfig(o.env ?? process.env);
    if (c.enabled) {
      kit = createOnrampServerKit({ apiKey: c.apiKey, baseUrl: c.baseUrl, widgetBaseUrl: c.widgetBaseUrl, referrerDomain: c.referrerDomain });
      environment = c.environment;
      widgetBaseUrl = c.widgetBaseUrl;
    }
  }
  // Each session is a call to Circle on our key; a visitor gets a handful.
  const perVisitor = o.perVisitor ?? createLimiter({ max: 10, windowMs: 10 * 60_000 });

  app.get("/api/onramp/status", (_req, res) => {
    res.json(kit ? { enabled: true, environment, widgetBaseUrl } : { enabled: false });
  });

  app.post("/api/onramp/session", async (req, res) => {
    res.set("cache-control", "no-store"); // session tokens must never be cached
    if (!kit) return res.status(503).json({ error: "Card funding isn't switched on yet." });
    const address = req.body?.address;
    if (typeof address !== "string" || !isAddress(address, { strict: false })) {
      return res.status(400).json({ error: "Connect a wallet first: the USDC goes to its address." });
    }
    if (!perVisitor.take(req.ip)) return res.status(429).json({ error: "That's a lot of checkouts. Try again in a few minutes." });
    try {
      const session = await kit.createSession({
        // One identity per wallet, so a returning buyer keeps their verification.
        appUserId: `wallet-${address.toLowerCase()}`,
        destinationAddress: address,
        assets: { pairs: [{ token: "USDC", chain: "arc" }] },
      });
      res.json(session);
    } catch (err) {
      if (isKitError(err) && STATUS[err.type]) {
        if (STATUS[err.type] >= 500) console.error("[onramp]", err.type, err.code, err.message);
        return res.status(STATUS[err.type]).json({ error: MESSAGE[err.type] });
      }
      console.error("[onramp]", err);
      res.status(500).json({ error: "Couldn't start the checkout on our side. Try again." });
    }
  });
}
