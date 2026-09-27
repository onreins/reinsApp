# Bridge: any strategy, inside a mandate

Strategy "brains" send signals; the bridge turns each one into at most one
trade inside a mandate, sized within the mandate's own per-trade cap. The
contract still enforces every rule, so a bad signal can at worst make a bad
trade inside the limits, never move money out.

A signal for an asset that isn't tradable on Arc yet is recorded as a
**shadow** trade instead. That shadow log is a strategy's paper record, so it
has a history by the time the asset lists. To switch an asset on: put its Arc
token symbol in `assets.json` and create a mandate that allows it.

## Run the bridge

```
BRIDGE_SECRET=<long random string>
MANDATE_ADDRESS=0x...        # the mandate
MANDATE_AGENT_KEY=0x...      # the mandate's AGENT key, never the owner's
MANDATE_NETWORK=testnet
BRIDGE_MODE=shadow           # default; set live to send trades
npm run bridge               # listens on 127.0.0.1:4300
```

Every outcome is appended to `bridge/data/ledger.jsonl`:
traded, refused (with the rule that refused it), skipped, shadow, hold,
none, duplicate. `GET /ledger?key=<secret>` shows the latest.

## Brain 1: NostalgiaForInfinity (or any freqtrade strategy)

Run freqtrade unmodified with `"dry_run": true` on an exchange's price data,
and merge `freqtrade.webhook.json` into its config (put your secret in the
URL). Each simulated fill is posted to the bridge. freqtrade and NFI are
GPL-3.0 and stay a separate program talking over HTTP; nothing of theirs is
copied into this repo.

Pairs without an Arc token (BTC/USDT today) become shadow trades. Shorts are
refused: a mandate is spot only.

## Brain 2: TradingAgents

Install the official project from source, pinned, in its own virtual
environment. **Don't** `pip install tradingagents`: that PyPI name is a
different project (github.com/Mai0313/tradingagents), not TauricResearch's.

```
git clone https://github.com/TauricResearch/TradingAgents.git
cd TradingAgents && git checkout v0.5.1
python3.12 -m venv .venv && .venv/Scripts/activate && pip install .
ANTHROPIC_API_KEY=...  BRIDGE_SECRET=...  TA_TICKERS=SPY,NVDA
python path/to/ratchet/bridge/runners/tradingagents.py      # once a day
```

Before installing any brain (TradingAgents, freqtrade, NFI): take it only
from its official GitHub org, pin a release, read its dependency list, run
`pip-audit` in the venv, and scan the folder with Windows Defender. Give it
the mandate's agent key only, never the owner's.

It asks TradingAgents for BUY / SELL / HOLD per ticker and posts it. One
decision per ticker per day: rerunning the same day is a duplicate, not a
second trade.

## What the bridge will and won't do

- Buys are capped at the mandate's per-trade limit and the cash it holds.
- An exit sells the whole position, capped by value at the per-trade limit.
- A frozen or expired mandate is skipped, not retried.
- A retried webhook with the same id is recorded as a duplicate and not traded.
- It never raises a limit, and it can't: limits live in the contract.
- A trade that was sent but couldn't be confirmed is recorded as `unknown`
  with its transaction hash, and never resent. Check the hash on the explorer.
- Can't price a position? It won't sell it: the per-trade cap needs a price.

## Operating notes

- Run **one** bridge per ledger file. Duplicate protection lives in the
  process and its ledger; two bridges on the same file could each send a
  signal once.
- freqtrade puts the secret in the webhook URL. Keep that URL out of logs,
  shell history and any proxy in front of the bridge, and rotate the secret
  if it leaks. It only ever listens on 127.0.0.1.
