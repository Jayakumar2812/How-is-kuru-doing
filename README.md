# How is Kuru doing?

Live dashboard showing whether recent Monad blocks contain Kuru protocol activity (internal traces and top-level transactions).

## Data Sources

- **RPC:** private server-side `MONAD_RPC_URL` — latest block, timestamps, traces, transactions, and logs
- **Addresses:** [`kuru_addresses.json`](kuru_addresses.json)

A block is marked active if any trace or transaction has `to` matching a Kuru address (same logic as [`kuru_blocks_window.ipynb`](kuru_blocks_window.ipynb)).

## Local Development

1. Copy env file and add your RPC URL:

   ```bash
   cp .env.example .env.local
   # Edit .env.local and set MONAD_RPC_URL=...
   ```

2. Install and run:

   ```bash
   npm install
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000)

## MON liquidation clusters (`/mon`)

Dark desk page for **MON** perp **cross-exchange** liquidation / long-short clusters.

- Coinbase spot (`MON-USD`) plus per-venue mark / funding / OI
- Price-level **cluster map** with exchange toggles (Binance, Bybit, OKX, Bitget, Hyperliquid) and Longs / Shorts / Both
- Combined overlay (stacked per-exchange series) plus densest-bucket tables with an Exchange / Source column
- Venue detail: 24h completed long/short liquidations and account L/S when published

### Cluster vs summary

| Source | Role |
| --- | --- |
| **CoinGlass** heatmap / map (`COINGLASS_API_KEY`) | **Primary multi-CEX price-level clusters** for Binance, Bybit, OKX, Bitget (and HL if listed). Sides are mark-implied: below mark = longs, above = shorts. |
| **0xArchive** Hyperliquid levels (`ZEROX_ARCHIVE_API_KEY`) | Extra HL series with **source-split** long vs short buckets |
| CoinGlass exchange-list | 24h completed long/short liquidations per venue |
| Hyperliquid `metaAndAssetCtxs` | HL mark, funding, OI |
| Coinbase spot | `MON-USD` |
| Binance / Bybit / OKX / Bitget public REST | Mark, funding, OI, account L/S when the region allows |
| Gate public REST | Extra summary venue (hourly 24h liq stats) |
| Coinalyze | Optional key only; unavailable without it |

True CEX price-bucket heatmaps are not on public Binance/Bybit/OKX/Bitget REST. Without `COINGLASS_API_KEY` the map prompts for the key and still loads public spot/mark/funding — missing cells are unavailable, never invented.

Venue APIs are proxied through `GET /api/mon-clusters`. The page auto-refreshes about every 90 seconds and stamps last-updated in IST and UTC.

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the project in [Vercel](https://vercel.com/new)
3. Add environment variables: `MONAD_RPC_URL`, `COINGLASS_API_KEY` (multi-CEX cluster map), and optionally `ZEROX_ARCHIVE_API_KEY` (Hyperliquid source-split clusters)
4. Deploy — Vercel auto-detects Next.js

The API routes are configured for longer execution in [`vercel.json`](vercel.json).

## API

`GET /api/kuru-window?count=100&toBlock=<optional>`

Returns block-by-block Kuru activity for a rolling window (newest first).
