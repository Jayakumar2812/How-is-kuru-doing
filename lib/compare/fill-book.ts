/** Walk an L2 book to estimate base received when spending `quoteAmount` (human units). */

export interface BookLevel {
  /** Quote per base (e.g. USDC per MON) */
  price: number;
  /** Base size available at this level */
  size: number;
}

export interface BookFillResult {
  baseOut: number;
  quoteSpent: number;
  levelsUsed: number;
  fullyFilled: boolean;
}

/**
 * Buy base with quote by walking asks (lowest price first).
 * price = quote/base, size = base available.
 */
export function fillBuyWithQuote(asks: BookLevel[], quoteAmount: number): BookFillResult {
  let quoteLeft = quoteAmount;
  let baseOut = 0;
  let levelsUsed = 0;

  const sorted = [...asks]
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => a.price - b.price);

  for (const level of sorted) {
    if (quoteLeft <= 0) break;
    const maxBaseAffordable = quoteLeft / level.price;
    const takeBase = Math.min(level.size, maxBaseAffordable);
    if (takeBase <= 0) continue;
    const spend = takeBase * level.price;
    baseOut += takeBase;
    quoteLeft -= spend;
    levelsUsed += 1;
  }

  return {
    baseOut,
    quoteSpent: quoteAmount - quoteLeft,
    levelsUsed,
    fullyFilled: quoteLeft < quoteAmount * 0.001,
  };
}

export function midFromBook(bids: BookLevel[], asks: BookLevel[]): number | null {
  const bestBid = bids.filter((l) => l.price > 0).sort((a, b) => b.price - a.price)[0];
  const bestAsk = asks.filter((l) => l.price > 0).sort((a, b) => a.price - b.price)[0];
  if (!bestBid || !bestAsk) return null;
  return (bestBid.price + bestAsk.price) / 2;
}

export function priceImpactFromFill(mid: number | null, quoteSpent: number, baseOut: number): number | null {
  if (!mid || mid <= 0 || baseOut <= 0 || quoteSpent <= 0) return null;
  const avgPrice = quoteSpent / baseOut;
  return ((avgPrice - mid) / mid) * 100;
}

/**
 * Buy-side slippage vs mid in basis points (100 bps = 1%).
 * Same formula as markets-volume-tracker `lib/depth/slippage.ts` / Metric mid math.
 */
export function buySlippageBps(execPrice: number | null, midPrice: number | null): number | null {
  if (
    execPrice == null ||
    midPrice == null ||
    !Number.isFinite(execPrice) ||
    !Number.isFinite(midPrice) ||
    midPrice <= 0 ||
    execPrice <= 0
  ) {
    return null;
  }
  return ((execPrice - midPrice) / midPrice) * 10_000;
}

/** VWAP buy slippage from a book fill (quoteSpent / baseOut vs mid). */
export function buySlippageBpsFromFill(
  mid: number | null,
  quoteSpent: number,
  baseOut: number
): number | null {
  if (!mid || mid <= 0 || baseOut <= 0 || quoteSpent <= 0) return null;
  return buySlippageBps(quoteSpent / baseOut, mid);
}
