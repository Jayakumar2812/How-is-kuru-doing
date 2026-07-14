import "server-only";

import {
  buySlippageBpsFromFill,
  fillBuyWithQuote,
  midFromBook,
  priceImpactFromFill,
  type BookLevel,
} from "@/lib/compare/fill-book";
import {
  COMPARE_AMOUNTS_USD,
  formatOutAmount,
  type CompareTokenOut,
  type SizeQuote,
  type VenueQuoteRow,
} from "@/lib/compare/tokens";

interface PairCandidate {
  pair: string;
  decimals: number;
  symbol: string;
  note?: string;
}

interface BookResult {
  bids: BookLevel[];
  asks: BookLevel[];
  candidate: PairCandidate;
}

interface CoinbaseBook {
  pricebook?: {
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
  };
}

interface BinanceBook {
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
  code?: number;
  msg?: string;
}

interface BybitBook {
  result?: {
    bids?: Array<[string, string]>;
    asks?: Array<[string, string]>;
    b?: Array<[string, string]>;
    a?: Array<[string, string]>;
  };
}

interface OkxBook {
  data?: Array<{
    bids?: string[][];
    asks?: string[][];
  }>;
}

interface LighterBook {
  bids?: Array<{ price: string; remaining_base_amount: string }>;
  asks?: Array<{ price: string; remaining_base_amount: string }>;
}

function parseLevels(levels: Array<[string, string]>): BookLevel[] {
  return levels
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        Number.isFinite(level.size) &&
        level.price > 0 &&
        level.size > 0
    );
}

async function fetchJson<T>(url: string, timeoutMs = 6_000): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function coinbaseCandidates(tokenOut: CompareTokenOut): PairCandidate[] {
  switch (tokenOut) {
    case "MON":
      return [{ pair: "MON-USDC", decimals: 2, symbol: "MON", note: "MON/USDC spot" }];
    case "WETH":
      return [{ pair: "ETH-USDC", decimals: 8, symbol: "ETH", note: "ETH/USDC spot" }];
    case "cbBTC":
      return [
        { pair: "BTC-USDC", decimals: 8, symbol: "BTC", note: "BTC/USDC spot" },
        {
          pair: "BTC-USD",
          decimals: 8,
          symbol: "BTC",
          note: "BTC/USD spot (USD ≈ USDC)",
        },
      ];
    case "XAUT0":
      return [
        {
          pair: "PAXG-USDC",
          decimals: 8,
          symbol: "PAXG",
          note: "PAXG/USDC gold proxy",
        },
      ];
  }
}

function binanceCandidates(tokenOut: CompareTokenOut): PairCandidate[] {
  switch (tokenOut) {
    case "MON":
      return [
        { pair: "MONUSDC", decimals: 2, symbol: "MON", note: "MON/USDC spot" },
        {
          pair: "MONUSDT",
          decimals: 2,
          symbol: "MON",
          note: "MON/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "WETH":
      return [
        { pair: "ETHUSDC", decimals: 8, symbol: "ETH", note: "ETH/USDC spot" },
        {
          pair: "ETHUSDT",
          decimals: 8,
          symbol: "ETH",
          note: "ETH/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "cbBTC":
      return [
        { pair: "BTCUSDC", decimals: 8, symbol: "BTC", note: "BTC/USDC spot" },
        {
          pair: "BTCUSDT",
          decimals: 8,
          symbol: "BTC",
          note: "BTC/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "XAUT0":
      return [
        { pair: "XAUTUSDC", decimals: 6, symbol: "XAUT", note: "XAUT/USDC spot" },
        {
          pair: "XAUTUSDT",
          decimals: 6,
          symbol: "XAUT",
          note: "XAUT/USDT spot (USDT ≈ USDC)",
        },
      ];
  }
}

function bybitCandidates(tokenOut: CompareTokenOut): PairCandidate[] {
  switch (tokenOut) {
    case "MON":
      return [
        {
          pair: "MONUSDT",
          decimals: 2,
          symbol: "MON",
          note: "MON/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "WETH":
      return [
        { pair: "ETHUSDC", decimals: 8, symbol: "ETH", note: "ETH/USDC spot" },
        {
          pair: "ETHUSDT",
          decimals: 8,
          symbol: "ETH",
          note: "ETH/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "cbBTC":
      return [
        { pair: "BTCUSDC", decimals: 8, symbol: "BTC", note: "BTC/USDC spot" },
        {
          pair: "BTCUSDT",
          decimals: 8,
          symbol: "BTC",
          note: "BTC/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "XAUT0":
      return [
        {
          pair: "XAUTUSDT",
          decimals: 6,
          symbol: "XAUT",
          note: "XAUT/USDT spot (USDT ≈ USDC)",
        },
      ];
  }
}

function okxCandidates(tokenOut: CompareTokenOut): PairCandidate[] {
  switch (tokenOut) {
    case "MON":
      return [
        { pair: "MON-USDC", decimals: 2, symbol: "MON", note: "MON/USDC spot" },
        {
          pair: "MON-USDT",
          decimals: 2,
          symbol: "MON",
          note: "MON/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "WETH":
      return [
        { pair: "ETH-USDC", decimals: 8, symbol: "ETH", note: "ETH/USDC spot" },
        {
          pair: "ETH-USDT",
          decimals: 8,
          symbol: "ETH",
          note: "ETH/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "cbBTC":
      return [
        { pair: "BTC-USDC", decimals: 8, symbol: "BTC", note: "BTC/USDC spot" },
        {
          pair: "BTC-USDT",
          decimals: 8,
          symbol: "BTC",
          note: "BTC/USDT spot (USDT ≈ USDC)",
        },
      ];
    case "XAUT0":
      return [
        {
          pair: "XAUT-USDT",
          decimals: 6,
          symbol: "XAUT",
          note: "XAUT/USDT spot (USDT ≈ USDC)",
        },
      ];
  }
}

function lighterCandidate(
  tokenOut: CompareTokenOut
): (PairCandidate & { marketId: number }) | null {
  switch (tokenOut) {
    case "MON":
      return {
        pair: "MON",
        marketId: 91,
        decimals: 1,
        symbol: "MON",
        note: "MON/USDC Lighter perpetual order book",
      };
    case "WETH":
      return {
        pair: "ETH/USDC",
        marketId: 2048,
        decimals: 4,
        symbol: "ETH",
        note: "ETH/USDC Lighter spot",
      };
    case "cbBTC":
      return {
        pair: "BTC",
        marketId: 1,
        decimals: 5,
        symbol: "BTC",
        note: "BTC/USDC Lighter perpetual order book",
      };
    case "XAUT0":
      return {
        pair: "XAU",
        marketId: 92,
        decimals: 4,
        symbol: "XAU",
        note: "XAU/USDC Lighter gold perpetual order book",
      };
  }
}

async function fetchCoinbaseBook(candidates: PairCandidate[]): Promise<BookResult | null> {
  for (const candidate of candidates) {
    const url =
      "https://api.coinbase.com/api/v3/brokerage/market/product_book" +
      `?product_id=${encodeURIComponent(candidate.pair)}&limit=500`;
    const data = await fetchJson<CoinbaseBook>(url);
    const rawBids = data?.pricebook?.bids ?? [];
    const rawAsks = data?.pricebook?.asks ?? [];
    if (!rawAsks.length) continue;

    return {
      bids: parseLevels(rawBids.map((level) => [level.price, level.size])),
      asks: parseLevels(rawAsks.map((level) => [level.price, level.size])),
      candidate,
    };
  }
  return null;
}

async function fetchBinanceBook(candidates: PairCandidate[]): Promise<BookResult | null> {
  for (const candidate of candidates) {
    const url =
      "https://api.binance.com/api/v3/depth" +
      `?symbol=${encodeURIComponent(candidate.pair)}&limit=500`;
    const data = await fetchJson<BinanceBook>(url);
    if (!data?.asks?.length) continue;

    return {
      bids: parseLevels(data.bids ?? []),
      asks: parseLevels(data.asks),
      candidate,
    };
  }
  return null;
}

async function fetchBybitBook(candidates: PairCandidate[]): Promise<BookResult | null> {
  for (const candidate of candidates) {
    const url =
      "https://api.bybit.com/v5/market/orderbook" +
      `?category=spot&symbol=${encodeURIComponent(candidate.pair)}&limit=200`;
    const data = await fetchJson<BybitBook>(url);
    const result = data?.result;
    const asks = result?.asks ?? result?.a ?? [];
    if (!asks.length) continue;

    return {
      bids: parseLevels(result?.bids ?? result?.b ?? []),
      asks: parseLevels(asks),
      candidate,
    };
  }
  return null;
}

async function fetchOkxBook(candidates: PairCandidate[]): Promise<BookResult | null> {
  for (const candidate of candidates) {
    const url =
      "https://www.okx.com/api/v5/market/books" +
      `?instId=${encodeURIComponent(candidate.pair)}&sz=400`;
    const data = await fetchJson<OkxBook>(url);
    const book = data?.data?.[0];
    const asks = (book?.asks ?? []).map(
      (level) => [level[0], level[1]] as [string, string]
    );
    if (!asks.length) continue;

    return {
      bids: parseLevels(
        (book?.bids ?? []).map(
          (level) => [level[0], level[1]] as [string, string]
        )
      ),
      asks: parseLevels(asks),
      candidate,
    };
  }
  return null;
}

async function fetchLighterBook(
  candidate: PairCandidate & { marketId: number }
): Promise<BookResult | null> {
  const url =
    "https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders" +
    `?market_id=${candidate.marketId}&limit=250`;
  const data = await fetchJson<LighterBook>(url);
  const asks = data?.asks ?? [];
  if (!asks.length) return null;

  const toLevels = (
    levels: Array<{ price: string; remaining_base_amount: string }>
  ): Array<[string, string]> =>
    levels.map((level) => [level.price, level.remaining_base_amount]);

  return {
    bids: parseLevels(toLevels(data?.bids ?? [])),
    asks: parseLevels(toLevels(asks)),
    candidate,
  };
}

function emptyRow(venueId: string, venueName: string, note: string): VenueQuoteRow {
  return {
    venueId,
    venueName,
    section: "rest",
    quotes: COMPARE_AMOUNTS_USD.map((amountUsd) => ({
      amountUsd,
      amountOut: null,
      amountOutHuman: null,
      priceImpactPct: null,
      slippageBps: null,
      status: "na",
      note,
    })),
  };
}

function markLiquidityCaps(quotes: SizeQuote[]): void {
  let previousOut: bigint | null = null;
  let previousUsd: number | null = null;

  for (const quote of quotes) {
    if (quote.status !== "ok" || !quote.amountOut) continue;
    const currentOut = BigInt(quote.amountOut);
    if (
      previousOut !== null &&
      previousUsd !== null &&
      quote.amountUsd > previousUsd &&
      currentOut <= previousOut
    ) {
      quote.amountOut = null;
      quote.amountOutHuman = null;
      quote.priceImpactPct = null;
      quote.slippageBps = null;
      quote.status = "na";
      quote.note = `Book exhausted — same fill as $${previousUsd.toLocaleString()}`;
      continue;
    }
    previousOut = currentOut;
    previousUsd = quote.amountUsd;
  }
}

function quoteBook(
  venueId: string,
  venueName: string,
  book: BookResult
): VenueQuoteRow {
  const mid = midFromBook(book.bids, book.asks);
  const quotes: SizeQuote[] = COMPARE_AMOUNTS_USD.map((amountUsd) => {
    const fill = fillBuyWithQuote(book.asks, amountUsd);
    if (fill.baseOut <= 0) {
      return {
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "na" as const,
        note: "Insufficient spot depth",
      };
    }
    if (!fill.fullyFilled) {
      return {
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "na" as const,
        note: `Insufficient depth for full $${amountUsd.toLocaleString()} quote`,
      };
    }

    const scale = 10 ** book.candidate.decimals;
    const raw = BigInt(Math.floor(fill.baseOut * scale));
    const slippageBps = buySlippageBpsFromFill(
      mid,
      fill.quoteSpent,
      fill.baseOut
    );

    return {
      amountUsd,
      amountOut: raw.toString(),
      amountOutHuman: formatOutAmount(
        raw,
        book.candidate.decimals,
        book.candidate.symbol
      ),
      priceImpactPct: priceImpactFromFill(mid, fill.quoteSpent, fill.baseOut),
      slippageBps,
      status: "ok" as const,
      note: book.candidate.note,
    };
  });

  markLiquidityCaps(quotes);
  return { venueId, venueName, section: "rest", quotes };
}

export async function quoteCoinbase(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const candidates = coinbaseCandidates(tokenOut);
  const book = await fetchCoinbaseBook(candidates);
  return book
    ? quoteBook("coinbase", "Coinbase", book)
    : emptyRow("coinbase", "Coinbase", "No supported spot book");
}

export async function quoteBinance(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const candidates = binanceCandidates(tokenOut);
  const book = await fetchBinanceBook(candidates);
  return book
    ? quoteBook("binance", "Binance", book)
    : emptyRow("binance", "Binance", "No supported USDC/USDT spot book");
}

export async function quoteBybit(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const book = await fetchBybitBook(bybitCandidates(tokenOut));
  return book
    ? quoteBook("bybit", "Bybit", book)
    : emptyRow("bybit", "Bybit", "No supported USDC/USDT spot book");
}

export async function quoteOkx(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const book = await fetchOkxBook(okxCandidates(tokenOut));
  return book
    ? quoteBook("okx", "OKX", book)
    : emptyRow("okx", "OKX", "No supported USDC/USDT spot book");
}

export async function quoteLighter(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const candidate = lighterCandidate(tokenOut);
  if (!candidate) {
    return emptyRow("lighter", "Lighter", "No supported Lighter market");
  }
  const book = await fetchLighterBook(candidate);
  return book
    ? quoteBook("lighter", "Lighter", book)
    : emptyRow("lighter", "Lighter", "Order book unavailable");
}
