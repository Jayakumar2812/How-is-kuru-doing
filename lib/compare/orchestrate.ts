import "server-only";

import {
  quoteBinance,
  quoteBybit,
  quoteCoinbase,
  quoteLighter,
  quoteOkx,
} from "@/lib/compare/adapters/cex-books";
import { quoteHyperliquid } from "@/lib/compare/adapters/hyperliquid";
import { quoteJupiter } from "@/lib/compare/adapters/jupiter";
import { quoteKuru } from "@/lib/compare/adapters/kuru";
import { quoteMetric } from "@/lib/compare/adapters/metric";
import {
  quoteMonadUniswapV3,
  stubMonadVenue,
} from "@/lib/compare/adapters/uniswap-style";
import {
  readCompareQuotesFromBlob,
  writeCompareQuotesToBlob,
} from "@/lib/compare/compare-blob";
import { getMonadRpcUrl } from "@/lib/compare/rpc-urls";
import {
  COMPARE_AMOUNTS_USD,
  COMPARE_TOKENS,
  type CompareQuotesResponse,
  type CompareTokenOut,
  type VenueQuoteRow,
} from "@/lib/compare/tokens";
import { MONAD_UNISWAP_QUOTER, MONAD_VENUES } from "@/lib/compare/venues";

const RANK_TTL_MS = 60 * 60 * 1000;
const QUOTE_TTL_MS = 45_000;
/** Bump when quote math changes so in-memory cache cannot serve stale bad rows. */
const QUOTE_CACHE_VERSION = "v37-blobSnapshot";

const globalStore = globalThis as typeof globalThis & {
  __compareRankCache?: { at: number; ranks: Map<string, number> };
  __compareQuoteCache?: Map<string, { at: number; value: CompareQuotesResponse }>;
};

function quoteCache(): Map<string, { at: number; value: CompareQuotesResponse }> {
  if (!globalStore.__compareQuoteCache) {
    globalStore.__compareQuoteCache = new Map();
  }
  return globalStore.__compareQuoteCache;
}

function cacheKeyFor(tokenOut: CompareTokenOut): string {
  return `${QUOTE_CACHE_VERSION}:${tokenOut}`;
}

/** Memory → Blob snapshot for cachedOnly / first paint. Does not run live venue jobs. */
export async function getCachedCompareQuotes(
  tokenOut: CompareTokenOut
): Promise<CompareQuotesResponse | null> {
  const cache = quoteCache();
  const cacheKey = cacheKeyFor(tokenOut);
  const hit = cache.get(cacheKey);
  if (hit) {
    return { ...hit.value, cached: true };
  }

  const blob = await readCompareQuotesFromBlob(tokenOut);
  if (!blob) return null;

  cache.set(cacheKey, { at: Date.now(), value: blob });
  return blob;
}

async function fetchMonadDexRanks(): Promise<Map<string, number>> {
  const cached = globalStore.__compareRankCache;
  if (cached && Date.now() - cached.at < RANK_TTL_MS) {
    return cached.ranks;
  }

  const ranks = new Map<string, number>();
  try {
    const resp = await fetch(
      "https://api.llama.fi/overview/dexs/Monad?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true",
      { cache: "no-store" }
    );
    if (resp.ok) {
      const body = (await resp.json()) as {
        protocols?: Array<{ name?: string; total24h?: number; displayName?: string }>;
      };
      for (const protocol of body.protocols ?? []) {
        const name = protocol.name ?? protocol.displayName ?? "";
        const vol = protocol.total24h ?? 0;
        if (!name) continue;
        for (const venue of MONAD_VENUES) {
          if (!venue.llamaNames?.some((n) => name.toLowerCase().includes(n.toLowerCase()))) {
            continue;
          }
          const prev = ranks.get(venue.id) ?? 0;
          ranks.set(venue.id, prev + vol);
        }
      }
    }
  } catch {
    // Ranking is optional; fall through with empty map.
  }

  globalStore.__compareRankCache = { at: Date.now(), ranks };
  return ranks;
}

function withVolume(row: VenueQuoteRow, ranks: Map<string, number>): VenueQuoteRow {
  return { ...row, volume24hUsd: ranks.get(row.venueId) ?? null };
}

function sortMonadRows(rows: VenueQuoteRow[]): VenueQuoteRow[] {
  return [...rows].sort((a, b) => {
    if (a.highlight && !b.highlight) return -1;
    if (!a.highlight && b.highlight) return 1;
    return (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0);
  });
}

export async function buildCompareQuotes(
  tokenOut: CompareTokenOut,
  forceRefresh = false
): Promise<CompareQuotesResponse> {
  const cache = quoteCache();
  const cacheKey = cacheKeyFor(tokenOut);
  const hit = cache.get(cacheKey);
  if (!forceRefresh && hit && Date.now() - hit.at < QUOTE_TTL_MS) {
    return { ...hit.value, cached: true };
  }

  if (!forceRefresh) {
    const blob = await readCompareQuotesFromBlob(tokenOut);
    if (blob) {
      cache.set(cacheKey, { at: Date.now(), value: blob });
      return blob;
    }
  }

  const ranks = await fetchMonadDexRanks();
  let monadRpc: string;
  try {
    monadRpc = getMonadRpcUrl();
  } catch {
    monadRpc = "";
  }

  const monadJobs: Array<Promise<VenueQuoteRow>> = [
    quoteKuru(tokenOut),
    monadRpc
      ? quoteMonadUniswapV3(tokenOut, monadRpc, MONAD_UNISWAP_QUOTER, "uniswap-monad", "Uniswap")
      : Promise.resolve(stubMonadVenue("uniswap-monad", "Uniswap", "MONAD_RPC_URL not configured")),
    Promise.resolve(
      stubMonadVenue("lfj-monad", "LFJ", "One-hop LFJ quoter not wired — use DefiLlama rank only")
    ),
    quoteMetric(tokenOut),
    Promise.resolve(
      stubMonadVenue("balancer-monad", "Balancer", "One-hop Balancer path not wired")
    ),
    Promise.resolve(
      stubMonadVenue("clober-monad", "Clober", "Meta-aggregator multi-hop excluded")
    ),
    Promise.resolve(
      stubMonadVenue("mento-monad", "Mento", "One-hop Mento quoter not wired")
    ),
  ];

  const restJobs: Array<Promise<VenueQuoteRow>> = [
    quoteJupiter(tokenOut),
    quoteHyperliquid(tokenOut),
    quoteCoinbase(tokenOut),
    quoteOkx(tokenOut),
    quoteBybit(tokenOut),
    quoteLighter(tokenOut),
  ];

  // Binance has no MON/USDC or MON/USDT market.
  if (tokenOut !== "MON") {
    restJobs.push(quoteBinance(tokenOut));
  }

  const [monadRows, restRows] = await Promise.all([
    Promise.all(monadJobs),
    Promise.all(restJobs),
  ]);

  const response: CompareQuotesResponse = {
    amountsUsd: [...COMPARE_AMOUNTS_USD],
    tokenOut,
    withinMonad: sortMonadRows(monadRows.map((row) => withVolume(row, ranks))),
    vsRest: restRows,
    quotedAt: new Date().toISOString(),
    cached: false,
    mappingNote: COMPARE_TOKENS[tokenOut].mappingNote,
  };

  cache.set(cacheKey, { at: Date.now(), value: response });
  await writeCompareQuotesToBlob(tokenOut, response);
  return response;
}

export function isCompareTokenOut(value: string): value is CompareTokenOut {
  return value === "MON" || value === "WETH" || value === "cbBTC" || value === "XAUT0";
}
