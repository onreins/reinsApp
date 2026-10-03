// The browser bundle behind the Charts page: LuxAlgo's Vela workspace (Apache-2.0)
// with its three public market-data providers. Built by `npm run build:charts`
// into app/public/vendor/vela-workspace.js, which attaches window.ReinsVela.
export { VelaWorkspace } from "@luxalgo/vela/workspace";
export { BinanceProvider } from "@luxalgo/vela/providers/binance";
export { CoinbaseProvider } from "@luxalgo/vela/providers/coinbase";
export { HyperliquidProvider } from "@luxalgo/vela/providers/hyperliquid";
