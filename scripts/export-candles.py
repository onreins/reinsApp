"""Export minute candles for the strategy chat's backtester.

    python scripts/export-candles.py <freqtrade binance data dir> [out dir]

Reads <dir>/<COIN>_USDT-1m.feather (freqtrade's download format) for each coin
the chat supports and writes, per coin, into [out dir] (default data/candles,
which git ignores):

    <COIN>-1m.json  {"start": unix seconds of the first minute, "n": minutes}
    <COIN>-1m.bin   float32 open[n], high[n], low[n], close[n], little-endian

One entry per minute from the first to the last, with no gaps: a minute the
exchange has no candle for (an outage, a quiet market) carries the last close
as its open, high, low and close. Public market data only.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "AVAX", "LINK"]
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "data" / "candles"


def export(src: Path, out: Path, coin: str) -> None:
    df = pd.read_feather(src / f"{coin}_USDT-1m.feather", columns=["date", "open", "high", "low", "close"])
    df["date"] = pd.to_datetime(df["date"], utc=True)
    df = df.drop_duplicates("date").set_index("date").sort_index()
    full = pd.date_range(df.index[0], df.index[-1], freq="1min")
    have = len(df)
    df = df.reindex(full)
    close = df["close"].ffill()
    for col in ("open", "high", "low"):
        df[col] = df[col].fillna(close)
    df["close"] = close

    start = int(full[0].timestamp())
    n = len(df)
    arrays = [df[col].to_numpy(dtype="<f4") for col in ("open", "high", "low", "close")]
    if any(not np.isfinite(a).all() for a in arrays):
        raise SystemExit(f"{coin}: prices contain gaps that couldn't be filled")
    (out / f"{coin}-1m.bin").write_bytes(b"".join(a.tobytes() for a in arrays))
    (out / f"{coin}-1m.json").write_text(json.dumps({"start": start, "n": n}))
    print(f"{coin}: {n:,} minutes from {full[0]:%Y-%m-%d} to {full[-1]:%Y-%m-%d %H:%M}, {n - have:,} filled, {n * 16 / 1e6:.0f} MB")


def main(src, out=None):
    dst = Path(out) if out else DEFAULT_OUT
    dst.mkdir(parents=True, exist_ok=True)
    for coin in COINS:
        if not (Path(src) / f"{coin}_USDT-1m.feather").exists():
            print(f"{coin}: no minute candles in {src}, skipped")
            continue
        export(Path(src), dst, coin)
    print(f"wrote {dst}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(*sys.argv[1:])
