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

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the project in [Vercel](https://vercel.com/new)
3. Add environment variable: `MONAD_RPC_URL`
4. Deploy — Vercel auto-detects Next.js

The API routes are configured for longer execution in [`vercel.json`](vercel.json).

## API

`GET /api/kuru-window?count=100&toBlock=<optional>`

Returns block-by-block Kuru activity for a rolling window (newest first).
