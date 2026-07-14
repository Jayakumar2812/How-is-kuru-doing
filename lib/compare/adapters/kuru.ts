import "server-only";

import {
  decodeAmountOut,
  decodeKuruMarketParams,
  encodeKuruGetMarketParams,
  encodeKuruMarketBuy,
  ethCall,
  type KuruMarketParams,
} from "@/lib/compare/abi";
import {
  buySlippageBps,
  buySlippageBpsFromFill,
  fillBuyWithQuote,
  midFromBook,
  priceImpactFromFill,
  type BookLevel,
} from "@/lib/compare/fill-book";
import { getKuruApiBase, getMonadRpcUrl } from "@/lib/compare/rpc-urls";
import {
  COMPARE_AMOUNTS_USD,
  COMPARE_TOKENS,
  formatOutAmount,
  rawToNumber,
  type CompareTokenOut,
  type SizeQuote,
  type VenueQuoteRow,
} from "@/lib/compare/tokens";
import { KURU_DEPTH_SYMBOLS, KURU_MARKETS } from "@/lib/compare/venues";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** From markets-volume-tracker Kuru MON_USDC depth (raw on-chain integers). */
const KURU_PRICE_SCALE = 1e18;
const KURU_SIZE_SCALE = 1e10;

interface DepthResponse {
  bids?: Array<[string, string] | { price: string; size: string }>;
  asks?: Array<[string, string] | { price: string; size: string }>;
  b?: Array<[string, string]>;
  a?: Array<[string, string]>;
}

function parseRawLevels(raw: DepthResponse["bids"]): BookLevel[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (Array.isArray(entry)) {
        return { price: Number(entry[0]), size: Number(entry[1]) };
      }
      return { price: Number(entry.price), size: Number(entry.size) };
    })
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0);
}

/** Detect raw on-chain integers (human USDC prices for our tokens are << 1e6). */
function needsKuruRawScale(levels: BookLevel[]): boolean {
  if (levels.length === 0) return false;
  const sample = levels.slice(0, 20);
  const avg = sample.reduce((s, l) => s + l.price, 0) / sample.length;
  return avg > 1e6;
}

function applyKuruScales(levels: BookLevel[]): BookLevel[] {
  return levels.map((l) => ({
    price: l.price / KURU_PRICE_SCALE,
    size: l.size / KURU_SIZE_SCALE,
  }));
}

function normalizeDepthLevels(raw: DepthResponse["bids"]): BookLevel[] {
  const levels = parseRawLevels(raw);
  if (needsKuruRawScale(levels)) return applyKuruScales(levels);
  return levels.filter((l) => l.size > 0);
}

async function fetchDepthUrl(url: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] } | null> {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    const body = (await resp.json()) as DepthResponse;
    const bids = normalizeDepthLevels(body.bids ?? body.b);
    const asks = normalizeDepthLevels(body.asks ?? body.a);
    if (asks.length === 0) return null;
    return { bids, asks };
  } catch {
    return null;
  }
}

async function fetchDepth(symbol: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] } | null> {
  const base = getKuruApiBase();
  if (!base) return null;

  const candidates = [symbol, symbol.replace("_", ""), symbol.replace("_USDC", "USDC")];

  for (const sym of candidates) {
    const urls = [
      `${base}/api/v3/depth?symbol=${encodeURIComponent(sym)}&limit=5000&state=committed`,
      `${base}/api/v3/depth?symbol=${encodeURIComponent(sym)}&limit=5000`,
      `${base}/api/v3/depth?symbol=${encodeURIComponent(sym)}&limit=200&state=committed`,
    ];
    for (const url of urls) {
      const depth = await fetchDepthUrl(url);
      if (depth) return depth;
    }
  }
  return null;
}

/**
 * Kuru CostEstimator.estimateMarketBuy scales human quote amount by pricePrecision
 * (not USDC token decimals): quoteSize = amountUsd * pricePrecision.
 */
function quoteSizeFromUsd(amountUsd: number, pricePrecision: bigint): bigint {
  return BigInt(Math.round(amountUsd)) * pricePrecision;
}

async function fetchMarketParams(rpcUrl: string, market: string): Promise<KuruMarketParams | null> {
  const result = await ethCall(rpcUrl, market, encodeKuruGetMarketParams(), ZERO_ADDRESS);
  if (!result) return null;
  return decodeKuruMarketParams(result);
}

/** Simulate placeAndExecuteMarketBuy on the Kuru orderbook (same as cast call --from 0x0). */
async function simulateMarketBuy(
  rpcUrl: string,
  market: string,
  quoteSize: bigint
): Promise<bigint | null> {
  const data = encodeKuruMarketBuy(quoteSize, BigInt(0));
  const result = await ethCall(rpcUrl, market, data, ZERO_ADDRESS);
  if (!result) return null;
  return decodeAmountOut(result);
}

function markLiquidityCaps(quotes: SizeQuote[]): void {
  let prevOut: bigint | null = null;
  let prevUsd: number | null = null;
  for (const q of quotes) {
    if (q.status !== "ok" || !q.amountOut) {
      prevOut = null;
      prevUsd = null;
      continue;
    }
    const out = BigInt(q.amountOut);
    if (prevOut !== null && prevUsd !== null && q.amountUsd > prevUsd && out <= prevOut) {
      q.status = "na";
      q.note = `Book exhausted — same fill as $${prevUsd.toLocaleString()} (thin asks)`;
      q.amountOutHuman = null;
      q.amountOut = null;
      q.slippageBps = null;
      q.priceImpactPct = null;
      continue;
    }
    prevOut = out;
    prevUsd = q.amountUsd;
  }
}

async function quoteViaOnChain(tokenOut: CompareTokenOut): Promise<VenueQuoteRow | null> {
  const meta = COMPARE_TOKENS[tokenOut];
  const market = KURU_MARKETS[tokenOut];
  let rpcUrl: string;
  try {
    rpcUrl = getMonadRpcUrl();
  } catch {
    return null;
  }

  const symbol = KURU_DEPTH_SYMBOLS[tokenOut];
  const [params, depth] = await Promise.all([
    fetchMarketParams(rpcUrl, market),
    symbol ? fetchDepth(symbol) : Promise.resolve(null),
  ]);
  if (!params) return null;

  const mid = depth ? midFromBook(depth.bids, depth.asks) : null;
  const outDecimals = params.baseAssetDecimals || meta.decimals;
  let referenceOut: bigint | null = null;
  try {
    referenceOut = await simulateMarketBuy(
      rpcUrl,
      market,
      quoteSizeFromUsd(COMPARE_AMOUNTS_USD[0], params.pricePrecision)
    );
  } catch {
    // L2 mid still provides a baseline where depth is available.
  }
  const referenceOutHuman =
    referenceOut != null && referenceOut > BigInt(0)
      ? rawToNumber(referenceOut, outDecimals)
      : 0;
  const referencePrice =
    referenceOutHuman > 0
      ? COMPARE_AMOUNTS_USD[0] / referenceOutHuman
      : null;
  const slippageBaseline = mid ?? referencePrice;
  const baselineLabel = mid
    ? "L2 mid"
    : `$${COMPARE_AMOUNTS_USD[0]} on-chain reference`;
  const quotes: SizeQuote[] = [];
  let anyOk = false;

  for (const amountUsd of COMPARE_AMOUNTS_USD) {
    try {
      const quoteSize = quoteSizeFromUsd(amountUsd, params.pricePrecision);
      const amountOut = await simulateMarketBuy(rpcUrl, market, quoteSize);
      if (amountOut === null || amountOut <= BigInt(0)) {
        quotes.push({
          amountUsd,
          amountOut: null,
          amountOutHuman: null,
          priceImpactPct: null,
          slippageBps: null,
          status: "na",
          note: "Market buy simulation returned empty",
        });
        continue;
      }

      const outHuman = rawToNumber(amountOut, outDecimals);
      const execPrice = outHuman > 0 ? amountUsd / outHuman : null;
      const slippage = buySlippageBps(execPrice, slippageBaseline);
      const impactPct = slippage != null ? slippage / 100 : null;

      anyOk = true;
      quotes.push({
        amountUsd,
        amountOut: amountOut.toString(),
        amountOutHuman: formatOutAmount(amountOut, outDecimals, meta.symbol),
        priceImpactPct: impactPct,
        slippageBps: slippage,
        status: "ok",
        note:
          slippage != null
            ? `On-chain market buy; buy slippage vs ${baselineLabel}`
            : "On-chain market buy (slippage reference unavailable)",
      });
    } catch (err) {
      quotes.push({
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "error",
        note: err instanceof Error ? err.message : "Simulation failed",
      });
    }
  }

  if (!anyOk) return null;

  markLiquidityCaps(quotes);

  return {
    venueId: "kuru",
    venueName: "Kuru",
    section: "monad",
    highlight: true,
    quotes,
  };
}

async function quoteViaDepth(tokenOut: CompareTokenOut): Promise<VenueQuoteRow | null> {
  const meta = COMPARE_TOKENS[tokenOut];
  const symbol = KURU_DEPTH_SYMBOLS[tokenOut];
  if (!symbol) return null;

  const depth = await fetchDepth(symbol);
  if (!depth) return null;

  const mid = midFromBook(depth.bids, depth.asks);
  const quotes: SizeQuote[] = COMPARE_AMOUNTS_USD.map((amountUsd) => {
    const fill = fillBuyWithQuote(depth.asks, amountUsd);
    if (fill.baseOut <= 0) {
      return {
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "na",
        note: "Insufficient book depth",
      };
    }

    const slippage = buySlippageBpsFromFill(mid, fill.quoteSpent, fill.baseOut);
    const raw = BigInt(Math.floor(fill.baseOut * 10 ** meta.decimals));
    return {
      amountUsd,
      amountOut: raw.toString(),
      amountOutHuman: formatOutAmount(raw, meta.decimals, meta.symbol),
      priceImpactPct: priceImpactFromFill(mid, fill.quoteSpent, fill.baseOut),
      slippageBps: slippage,
      status: "ok" as const,
      note: fill.fullyFilled ? "L2 depth fill" : "Partial fill vs requested size",
    };
  });

  markLiquidityCaps(quotes);

  return {
    venueId: "kuru",
    venueName: "Kuru",
    section: "monad",
    highlight: true,
    quotes,
  };
}

export async function quoteKuru(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const onChain = await quoteViaOnChain(tokenOut);
  if (onChain) return onChain;

  const depth = await quoteViaDepth(tokenOut);
  if (depth) return depth;

  return emptyRow("kuru", "Kuru", "On-chain sim and depth API both unavailable");
}

function emptyRow(id: string, name: string, note: string): VenueQuoteRow {
  return {
    venueId: id,
    venueName: name,
    section: "monad",
    highlight: id === "kuru",
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
