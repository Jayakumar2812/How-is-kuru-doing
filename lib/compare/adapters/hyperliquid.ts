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

interface SpotBook {
  levels?: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>];
}

interface MappedSpot {
  /** Preferred l2Book coin candidates (first that returns a usable book wins). */
  candidates: string[];
  decimals: number;
  symbol: string;
  note?: string;
  /** Optional mid from asset ctx to pick the right @index book. */
  expectedMid?: number;
  /** Aggregate fine-grained levels so the returned 20 levels expose enough depth. */
  nSigFigs?: number;
}

async function hlInfo<T>(payload: Record<string, unknown>): Promise<T | null> {
  try {
    const resp = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

function naRow(note: string): VenueQuoteRow {
  return {
    venueId: "hyperliquid",
    venueName: "Hyperliquid",
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

async function resolveMapped(tokenOut: CompareTokenOut): Promise<MappedSpot | null> {
  switch (tokenOut) {
    case "MON":
      return {
        candidates: ["MON"],
        decimals: 2,
        symbol: "MON",
        note: "MON/USDC Hyperliquid order-book equivalent",
        nSigFigs: 4,
      };
    case "WETH":
      return {
        candidates: ["ETH"],
        decimals: 4,
        symbol: "ETH",
        note: "ETH/USDC Hyperliquid order-book equivalent",
      };
    case "cbBTC":
      return {
        candidates: ["BTC"],
        decimals: 5,
        symbol: "BTC",
        note: "BTC/USDC Hyperliquid order-book equivalent",
      };
    case "XAUT0":
      return {
        candidates: ["@182"],
        decimals: 2,
        symbol: "XAUT0",
        note: "XAUT0/USDC spot (Hyperliquid XAUT)",
      };
  }
}

function bookMid(book: SpotBook): number | null {
  const bids = book.levels?.[0] ?? [];
  const asks = book.levels?.[1] ?? [];
  if (!bids.length || !asks.length) return null;
  return (Number(bids[0].px) + Number(asks[0].px)) / 2;
}

async function fetchBestBook(
  candidates: string[],
  expectedMid?: number,
  nSigFigs?: number
): Promise<{ coin: string; book: SpotBook } | null> {
  let best: { coin: string; book: SpotBook; score: number } | null = null;

  for (const coin of candidates) {
    const book = await hlInfo<SpotBook>({
      type: "l2Book",
      coin,
      ...(nSigFigs != null ? { nSigFigs } : {}),
    });
    if (!book?.levels) continue;
    const hasAsks = (book.levels[1]?.length ?? 0) > 0;
    const hasBids = (book.levels[0]?.length ?? 0) > 0;
    // Spot USDC markets need both sides; one-sided books are usually the wrong @index.
    if (!hasAsks || !hasBids) continue;

    const mid = bookMid(book);
    if (mid == null || mid <= 0) continue;

    let score = 3;
    if (expectedMid != null && expectedMid > 0) {
      const rel = Math.abs(mid - expectedMid) / expectedMid;
      if (rel > 0.2) continue; // reject books far from spot midPx
      score += 10 - rel * 10;
    }
    if (!best || score > best.score) best = { coin, book, score };
  }

  return best ? { coin: best.coin, book: best.book } : null;
}

export async function quoteHyperliquid(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const mapped = await resolveMapped(tokenOut);
  if (!mapped) {
    return naRow("No Hyperliquid spot USDC pair");
  }

  const hit = await fetchBestBook(
    mapped.candidates,
    mapped.expectedMid,
    mapped.nSigFigs
  );
  if (!hit) {
    return naRow("Spot book unavailable");
  }

  const bids: BookLevel[] = (hit.book.levels?.[0] ?? []).map((l) => ({
    price: Number(l.px),
    size: Number(l.sz),
  }));
  const asks: BookLevel[] = (hit.book.levels?.[1] ?? []).map((l) => ({
    price: Number(l.px),
    size: Number(l.sz),
  }));

  const mid = midFromBook(bids, asks) ?? mapped.expectedMid ?? null;
  const quotes: SizeQuote[] = COMPARE_AMOUNTS_USD.map((amountUsd) => {
    const fill = fillBuyWithQuote(asks, amountUsd);
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
    const raw = BigInt(Math.floor(fill.baseOut * 10 ** mapped.decimals));
    const slippage = buySlippageBpsFromFill(mid, fill.quoteSpent, fill.baseOut);
    return {
      amountUsd,
      amountOut: raw.toString(),
      amountOutHuman: formatOutAmount(raw, mapped.decimals, mapped.symbol),
      priceImpactPct: priceImpactFromFill(mid, fill.quoteSpent, fill.baseOut),
      slippageBps: slippage,
      status: "ok" as const,
      note: mapped.note,
    };
  });

  // Same plateau as Kuru when ask depth is exhausted across larger notionals.
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
      q.amountOut = null;
      q.amountOutHuman = null;
      q.slippageBps = null;
      q.priceImpactPct = null;
      q.note = `Book exhausted — same fill as $${prevUsd.toLocaleString()}`;
      continue;
    }
    prevOut = out;
    prevUsd = q.amountUsd;
  }

  return {
    venueId: "hyperliquid",
    venueName: "Hyperliquid",
    section: "rest",
    quotes,
  };
}
