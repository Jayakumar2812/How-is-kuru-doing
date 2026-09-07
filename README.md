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

Dark desk page for **MON** perp positioning:

- Coinbase spot (`MON-USD`) and Hyperliquid mark / funding / open interest
- Price-level **long vs short cluster chart** from Hyperliquid via [0xArchive](https://docs.0xarchive.io/hyperliquid-liquidations-data-api) `GET /v1/hyperliquid/liquidations/MON/levels`
- Venue **summary table** (mark, funding, OI, 24h completed long/short liquidations, account L/S when published)

Set `ZEROX_ARCHIVE_API_KEY` in `.env.local` (server-only). Without it, public spot/mark/funding still load and the heatmap asks for the key — missing cells are unavailable, never invented.

| Source | Role |
| --- | --- |
| 0xArchive Hyperliquid levels | **Cluster heatmap** (projected forced-liquidation buckets) |
| 0xArchive Hyperliquid volume | 24h completed HL long/short liquidations (same key) |
| Hyperliquid `metaAndAssetCtxs` | Mark, funding, OI |
| Coinbase spot | `MON-USD` |
| OKX `MON-USDT-SWAP` | Summary: mark, funding, OI, account L/S |
| Gate `MON_USDT` | Summary: mark, funding, OI, account L/S, 24h liq from hourly stats |
| Binance / Bybit public perps | Summary when reachable; often geo-blocked |
| CoinGlass / Coinalyze | Optional keys; used only if they respond — otherwise shown as unavailable |

Venue APIs are proxied through `GET /api/mon-clusters`. The page auto-refreshes about every 90 seconds and stamps last-updated in IST and UTC.

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the project in [Vercel](https://vercel.com/new)
3. Add environment variables: `MONAD_RPC_URL` and, for the MON cluster heatmap, `ZEROX_ARCHIVE_API_KEY`
4. Deploy — Vercel auto-detects Next.js

The API routes are configured for longer execution in [`vercel.json`](vercel.json).

## API

`GET /api/kuru-window?count=100&toBlock=<optional>`

Returns block-by-block Kuru activity for a rolling window (newest first).
