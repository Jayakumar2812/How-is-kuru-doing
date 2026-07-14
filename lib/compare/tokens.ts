import {
  CBBTC_ADDRESS,
  NATIVE_ADDRESS,
  USDC_ADDRESS,
  WETH_ADDRESS,
  XAUT0_ADDRESS,
} from "@/lib/tokens";

export const COMPARE_AMOUNTS_USD = [100, 1_000, 10_000, 25_000] as const;

export type CompareTokenOut = "MON" | "WETH" | "cbBTC" | "XAUT0";

export type QuoteStatus = "ok" | "na" | "error";

export type VenueSection = "monad" | "rest";

export interface CompareTokenMeta {
  id: CompareTokenOut;
  symbol: string;
  decimals: number;
  monadAddress: string;
  mappingNote: string;
}

export const COMPARE_TOKENS: Record<CompareTokenOut, CompareTokenMeta> = {
  MON: {
    id: "MON",
    symbol: "MON",
    decimals: 18,
    monadAddress: NATIVE_ADDRESS,
    mappingNote:
      "Monad: MON/USDC or WMON/USDC. Off-Monad: Jupiter WMON plus MON books on Hyperliquid, Coinbase, OKX, Bybit, and Lighter.",
  },
  WETH: {
    id: "WETH",
    symbol: "WETH",
    decimals: 18,
    monadAddress: WETH_ADDRESS,
    mappingNote:
      "Off-Monad: ETH/WETH on Jupiter, Hyperliquid, Coinbase, Binance, OKX, Bybit, and Lighter",
  },
  cbBTC: {
    id: "cbBTC",
    symbol: "cbBTC",
    decimals: 8,
    monadAddress: CBBTC_ADDRESS,
    mappingNote:
      "Off-Monad: BTC/WBTC against USDC/USDT on the listed CEX and order-book venues",
  },
  XAUT0: {
    id: "XAUT0",
    symbol: "XAUT0",
    decimals: 6,
    monadAddress: XAUT0_ADDRESS,
    mappingNote:
      "Off-Monad gold proxies: XAUT on Jupiter, Hyperliquid, Binance, OKX, and Bybit; XAU on Lighter; PAXG on Coinbase",
  },
};

export const MONAD_USDC = USDC_ADDRESS;

export interface SizeQuote {
  amountUsd: number;
  amountOut: string | null;
  amountOutHuman: string | null;
  priceImpactPct: number | null;
  /** Buy-side slippage vs mid in basis points (100 bps = 1%). */
  slippageBps: number | null;
  status: QuoteStatus;
  note?: string;
}

export interface VenueQuoteRow {
  venueId: string;
  venueName: string;
  section: VenueSection;
  highlight?: boolean;
  volume24hUsd?: number | null;
  quotes: SizeQuote[];
}

export interface CompareQuotesResponse {
  amountsUsd: number[];
  tokenOut: CompareTokenOut;
  withinMonad: VenueQuoteRow[];
  vsRest: VenueQuoteRow[];
  quotedAt: string;
  cached: boolean;
  mappingNote: string;
}

export function usdcRawFromUsd(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 1e6));
}

/** Fractional digits for compare cells — enough to tell venues apart without dashboard "0" rounding. */
function compareFracDigits(symbol: string, absAmount: number): number {
  switch (symbol) {
    case "cbBTC":
    case "WBTC":
    case "UBTC":
      if (absAmount >= 1) return 4;
      if (absAmount >= 0.01) return 6;
      return 8;
    case "WETH":
    case "ETH":
    case "UETH":
      if (absAmount >= 100) return 2;
      if (absAmount >= 1) return 4;
      return 6;
    case "XAUT0":
    case "XAUT":
    case "PAXG":
      if (absAmount >= 10) return 3;
      if (absAmount >= 1) return 4;
      return 6;
    case "MON":
    case "SOL":
      if (absAmount >= 1) return 2;
      return 4;
    default:
      if (absAmount >= 1) return 4;
      return 6;
  }
}

function trimFrac(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function formatFixed(absAmount: number, digits: number): string {
  if (!Number.isFinite(absAmount) || absAmount === 0) return "0";
  return trimFrac(absAmount.toFixed(digits));
}

/**
 * Format a raw on-chain amount for the compare table.
 * Uses each token's real decimals, then display precision suited to price magnitude
 * (BTC/gold keep sub-0.01 digits; large MON uses k/mil).
 */
export function formatOutAmount(raw: bigint, decimals: number, symbol: string): string {
  if (raw === BigInt(0)) return `0 ${symbol}`;

  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  // Prefer string math for the integer part; Number is fine for display magnitude.
  const absAmount = Number(whole) + Number(frac) / Number(base);
  if (!Number.isFinite(absAmount) || absAmount === 0) {
    // Sub-Number.EPSILON dust relative to token unit — still show from raw string if possible.
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    const plain = fracStr ? `0.${fracStr}` : "0";
    return `${negative ? "-" : ""}${plain} ${symbol}`;
  }

  let body: string;
  if ((symbol === "MON" || symbol === "SOL") && absAmount >= 1_000_000) {
    body = `${formatFixed(absAmount / 1_000_000, absAmount >= 10_000_000 ? 1 : 2)} mil`;
  } else if ((symbol === "MON" || symbol === "SOL") && absAmount >= 10_000) {
    body = `${formatFixed(absAmount / 1_000, absAmount >= 100_000 ? 0 : 1)}k`;
  } else {
    const digits = Math.min(decimals, compareFracDigits(symbol, absAmount));
    // Build from raw when under 1e15 to avoid float glitches on high-decimal tokens.
    if (whole < BigInt(1_000_000_000_000_000)) {
      const scaled = abs * BigInt(10) ** BigInt(digits) / base;
      const intPart = scaled / BigInt(10) ** BigInt(digits);
      const fracPart = scaled % BigInt(10) ** BigInt(digits);
      if (digits === 0 || fracPart === BigInt(0)) {
        body = intPart.toLocaleString("en-US");
      } else {
        const fracStr = fracPart.toString().padStart(digits, "0").replace(/0+$/, "");
        body = `${intPart.toLocaleString("en-US")}.${fracStr}`;
      }
    } else {
      body = formatFixed(absAmount, digits);
    }
  }

  return `${negative ? "-" : ""}${body} ${symbol}`;
}

export function rawToNumber(raw: bigint, decimals: number): number {
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  return Number(whole) + Number(frac) / Number(base);
}
