# Strategy chat

The app's **Strategy chat** tab (`/chat.html`): people describe a trading idea
in plain words, a model turns it into a strategy spec, and the app backtests it
on real daily prices after fees.

```
chat page → POST /api/chat → respond() → model (JSON: reply + spec)
                                  │           └─ refused by the schema? one retry, then dropped
                                  └─ no model / busy / over budget → offline builder
            validated spec → backtest() on app/data/prices.json → words + numbers + curve
```

- `spec.js` is the boundary. A spec is data, never code: seven series (price,
  SMA, EMA, RSI, N-day high/low, a number), four comparisons, rules or DCA,
  eight coins. Anything else, including fields nobody defined, is refused.
- `backtest.js` computes every number the page shows. Long-only spot, daily
  candles, signals at the close filled at the next open, 0.1% per fill, stops
  at their level or the open if the price gapped through. The model never
  states returns.
- `chat.js` holds the system prompt, the retry, and the offline builder (trend
  filter, golden cross, RSI dip, breakout, DCA), so the tab works with no model.
- `routes.js` rate-limits per visitor (20 messages / 10 min) and in total (400
  model calls / hour, shared free keys). Past either, the offline builder
  answers instead of refusing.

## Connecting a model

Any OpenAI-compatible endpoint works. Set these in `.env`, then restart `npm run app`:

```bash
LLM_BASE_URL=http://127.0.0.1:3001/v1   # FreeLLMAPI, or e.g. https://api.groq.com/openai/v1
LLM_API_KEY=...                          # FreeLLMAPI's unified key, or the provider's key
LLM_MODEL=auto                           # "auto" for FreeLLMAPI's router, or a model id
```

Behind a reverse proxy (nginx, a PaaS, Cloudflare), also set `TRUST_PROXY` to
the number of proxy hops (or `loopback`). Without it every visitor shares the
proxy's address, and one person could use up everyone's chat limit.

**Running now:** Cloudflare Workers AI directly, with Llama 3.3 70B
(`LLM_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1`,
`LLM_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast`, a Workers AI token as
`LLM_API_KEY`). The free tier is 10,000 neurons a day; past it, or when the
model errors, the chat answers from the offline builder.

Another simple start is **Groq directly**: its terms allow serving end users and
it does not train on prompts. Put a Groq key in `LLM_API_KEY`, set the base URL
above and pick one of its models.

### Through FreeLLMAPI (many free tiers behind one endpoint)

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT) pools providers'
free tiers and fails over between them. Reviewed 2026-09-28 (v0.12.0): no
telemetry beyond a signed model-catalog fetch; keys are AES-256-GCM encrypted.
Run it locked down:

- Docker, pinned by image **digest** (not `:latest`); `HOST_BIND=127.0.0.1`,
  port 3001 firewalled. Never expose it; only this server talks to it.
- `CATALOG_SYNC_DISABLED=1`: otherwise the twice-daily catalog can re-enable
  providers, and failover could then send prompts to one that trains on them.
- `FREELLMAPI_UPDATE_CHECK=off`.
- Raise `PROXY_RATE_LIMIT_RPM`: all our traffic arrives from one IP.
- Create the dashboard account immediately; keep the unified key on the server only.

Providers (free-tier terms checked 2026-09-28):

| Provider | Use? | Why |
|---|---|---|
| Groq | **Yes** | Explicitly allows end users; no training on prompts |
| Cloudflare Workers AI | **Yes** | Commercial product; no training; 10k neurons/day |
| Gemini free | Fallback only | Trains on prompts (human review); serving EEA/UK/CH users needs the paid tier |
| Mistral free, OpenRouter `:free`, Cerebras | No | Evaluation-only, bans multiple accounts, or now a paid trial |
| GitHub Models | No | Retired 2026-07-30 |

The chat tells visitors not to share personal details, since some fallbacks
train on prompts.

## Prices

`app/data/prices.json` holds Binance daily candles for BTC, ETH, SOL, XRP, BNB,
DOGE, AVAX and LINK from 2019. Refresh it from freqtrade's data folder:

```bash
python scripts/export-prices.py <freqtrade>/user_data/data/binance
```

### Minute prices (any timeframe down to 1 minute)

Strategies can check their rules every 1m, 5m, 15m, 1h, 4h or 1d, and each
average or RSI can sit on its own timeframe ("100-minute EMA crosses the 50-day
average"). Everything under a day is built from Binance 1-minute candles, about
60 MB per coin (457 MB for all eight), kept **outside git** in `data/candles/`
(or `CANDLES_DIR`):

```bash
freqtrade download-data --exchange binance --trading-mode spot --timeframes 1m --timerange 20190101- --pairs BTC/USDT ETH/USDT ...
python scripts/export-candles.py <freqtrade>/user_data/data/binance
```

The server loads a coin's minutes on first use and keeps the last three in
memory. A full 7-year backtest on 1-minute candles takes about 0.3 s. Without
the files, daily strategies still work and shorter ones get a plain "minute
prices for X aren't on this server" answer. A slower series is only read once
its candle has closed, so a minute strategy sees yesterday's 50-day average,
never today's unfinished one.

## Limits worth knowing

- These coins aren't tradeable on Arc yet (only USDC/EURC have pools), so a
  chat strategy is a study until pools launch; the page says so.
- "Create an agent" opens the normal create flow; a chat spec doesn't yet run
  as an agent's brain through the bridge.
