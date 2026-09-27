"""
TradingAgents -> Reins bridge.

Asks TradingAgents (github.com/TauricResearch/TradingAgents, Apache-2.0) for
today's BUY / SELL / HOLD on each ticker and posts the answer to the bridge.
The bridge trades it inside the mandate, or records a shadow trade if the
asset isn't on Arc yet. Run it once a day (cron, Task Scheduler).

Install the official project from source. Do NOT `pip install tradingagents`:
that PyPI name belongs to a different project (github.com/Mai0313/tradingagents).

    git clone https://github.com/TauricResearch/TradingAgents.git
    cd TradingAgents && git checkout v0.5.1      # pin a reviewed release
    python3.12 -m venv .venv && .venv/Scripts/activate
    pip install .
    set ANTHROPIC_API_KEY, BRIDGE_SECRET
    python path/to/ratchet/bridge/runners/tradingagents.py

Env:
    BRIDGE_URL      default http://127.0.0.1:4300
    BRIDGE_SECRET   required; the bridge's shared secret
    TA_TICKERS      default "SPY,NVDA"
    TA_SIZE_USD     dollars per buy; the mandate's own cap still applies
    TA_DEEP_MODEL   default claude-opus-5-5
    TA_QUICK_MODEL  default claude-sonnet-5
"""
import datetime
import json
import os
import sys
import urllib.request

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph


def post(url, secret, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-bridge-secret": secret},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def main():
    secret = os.environ.get("BRIDGE_SECRET")
    if not secret:
        sys.exit("set BRIDGE_SECRET")
    url = os.environ.get("BRIDGE_URL", "http://127.0.0.1:4300").rstrip("/") + "/signal"
    tickers = [t.strip().upper() for t in os.environ.get("TA_TICKERS", "SPY,NVDA").split(",") if t.strip()]
    size = os.environ.get("TA_SIZE_USD")
    today = datetime.date.today().isoformat()

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = "anthropic"
    config["deep_think_llm"] = os.environ.get("TA_DEEP_MODEL", "claude-opus-5-5")
    config["quick_think_llm"] = os.environ.get("TA_QUICK_MODEL", "claude-sonnet-5")
    graph = TradingAgentsGraph(debug=False, config=config)

    for ticker in tickers:
        _, decision = graph.propagate(ticker, today)
        body = {
            "source": "tradingagents",
            "ticker": ticker,
            "decision": str(decision),
            # One decision per ticker per day: a rerun the same day is a duplicate, not a second trade.
            "id": f"tradingagents:{ticker}:{today}",
        }
        if size:
            body["sizeUsd"] = float(size)
        result = post(url, secret, body)
        print(f"{ticker}: {str(decision)[:60]!r} -> {result.get('outcome')} ({result.get('reason', '')})")


if __name__ == "__main__":
    main()
