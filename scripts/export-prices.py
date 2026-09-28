"""Export daily candles for the strategy chat's backtester.

    python scripts/export-prices.py <freqtrade binance data dir>

Reads <dir>/<COIN>_USDT-1d.feather (freqtrade's download format) for each coin
the chat supports and writes app/data/prices.json: per coin, day numbers
(days since 1970-01-01) and open/high/low/close, rounded to six significant
figures. Public market data only; nothing here is a strategy.
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "AVAX", "LINK"]
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "prices.json"


def sig(x, digits=6):
    if not x or not math.isfinite(x):
        return 0
    return float(f"{x:.{digits}g}")


def main(src):
    out = {"source": "Binance spot daily candles (USDT)", "coins": {}}
    for coin in COINS:
        df = pd.read_feather(Path(src) / f"{coin}_USDT-1d.feather").sort_values("date")
        # Whatever unit the timestamps are stored in, count whole UTC days.
        epoch = pd.Timestamp("1970-01-01", tz="UTC")
        days = (pd.to_datetime(df["date"], utc=True) - epoch).dt.days.astype(int).tolist()
        out["coins"][coin] = {
            "d": days,
            "o": [sig(v) for v in df["open"]],
            "h": [sig(v) for v in df["high"]],
            "l": [sig(v) for v in df["low"]],
            "c": [sig(v) for v in df["close"]],
        }
        print(f"{coin}: {len(days)} days")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
