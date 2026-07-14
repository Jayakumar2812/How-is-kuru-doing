import "server-only";

import {
  decodeAmountOut,
  encodeQuoteExactInputSingle,
  encodeV4QuoteExactInputSingle,
  ethCall,
} from "@/lib/compare/abi";
import { buySlippageBps } from "@/lib/compare/fill-book";
import {
  COMPARE_AMOUNTS_USD,
  COMPARE_TOKENS,
  MONAD_USDC,
  formatOutAmount,
  rawToNumber,
  usdcRawFromUsd,
  type CompareTokenOut,
  type SizeQuote,
  type VenueQuoteRow,
  type VenueSection,
} from "@/lib/compare/tokens";
import { WMON_ADDRESS } from "@/lib/tokens";
import {
  FEE_TIERS,
  MONAD_UNISWAP_V4_CBBTC_POOL_ID,
  MONAD_UNISWAP_V4_QUOTER,
} from "@/lib/compare/venues";

const REFERENCE_USD = COMPARE_AMOUNTS_USD[0];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function bestSingleHopOut(params: {
  rpcUrl: string;
  quoter: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}): Promise<bigint | null> {
  const outputs = await Promise.all(
    FEE_TIERS.map(async (fee) => {
    const data = encodeQuoteExactInputSingle({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      fee,
    });
      try {
        const result = await ethCall(params.rpcUrl, params.quoter, data);
        if (!result) return null;
        const amountOut = decodeAmountOut(result);
        return amountOut != null && amountOut > BigInt(0) ? amountOut : null;
      } catch {
        return null;
      }
    })
  );

  let best: bigint | null = null;
  for (const amountOut of outputs) {
    if (amountOut == null) continue;
    if (best === null || amountOut > best) best = amountOut;
  }

  return best;
}

export async function quoteUniswapStyle(params: {
  venueId: string;
  venueName: string;
  section: VenueSection;
  rpcUrl: string;
  quoter: string;
  tokenIn: string;
  tokenOutAddress: string | null;
  tokenOut: CompareTokenOut;
  outDecimals: number;
  outSymbol: string;
  naNote?: string;
  highlight?: boolean;
}): Promise<VenueQuoteRow> {
  if (!params.tokenOutAddress) {
    return naVenue(params, params.naNote ?? "No direct USDC market on this chain");
  }

  const quoteArgs = {
    rpcUrl: params.rpcUrl,
    quoter: params.quoter,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOutAddress,
  };

  // Smallest displayed quote is stable across low-decimal assets such as cbBTC/XAUT0.
  const referenceOut = await bestSingleHopOut({
    ...quoteArgs,
    amountIn: usdcRawFromUsd(REFERENCE_USD),
  });
  const referenceHuman =
    referenceOut != null && referenceOut > BigInt(0)
      ? rawToNumber(referenceOut, params.outDecimals)
      : 0;
  const refPrice =
    referenceHuman > 0 ? REFERENCE_USD / referenceHuman : null;

  const quotes: SizeQuote[] = [];

  for (const amountUsd of COMPARE_AMOUNTS_USD) {
    try {
      const amountIn = usdcRawFromUsd(amountUsd);
      const amountOut = await bestSingleHopOut({
        ...quoteArgs,
        amountIn,
      });

      if (amountOut === null || amountOut <= BigInt(0)) {
        quotes.push({
          amountUsd,
          amountOut: null,
          amountOutHuman: null,
          priceImpactPct: null,
          slippageBps: null,
          status: "na",
          note: "No single-hop pool / quoter miss",
        });
        continue;
      }

      const outHuman = rawToNumber(amountOut, params.outDecimals);
      const execPrice = outHuman > 0 ? amountUsd / outHuman : null;
      const slippage = buySlippageBps(execPrice, refPrice);

      quotes.push({
        amountUsd,
        amountOut: amountOut.toString(),
        amountOutHuman: formatOutAmount(amountOut, params.outDecimals, params.outSymbol),
        priceImpactPct: slippage != null ? slippage / 100 : null,
        slippageBps: slippage,
        status: "ok",
        note:
          refPrice != null
            ? `Buy slippage vs $${REFERENCE_USD} reference quote`
            : undefined,
      });
    } catch (err) {
      quotes.push({
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "error",
        note: err instanceof Error ? err.message : "Quote failed",
      });
    }
  }

  return {
    venueId: params.venueId,
    venueName: params.venueName,
    section: params.section,
    highlight: params.highlight,
    quotes,
  };
}

async function quoteMonadV4CbBtc(
  rpcUrl: string,
  venueId: string,
  venueName: string
): Promise<VenueQuoteRow> {
  const cbBtc = COMPARE_TOKENS.cbBTC;
  const quoteOut = async (amountUsd: number): Promise<bigint | null> => {
    const data = encodeV4QuoteExactInputSingle({
      currency0: MONAD_USDC,
      currency1: cbBtc.monadAddress,
      fee: 500,
      tickSpacing: 10,
      hooks: ZERO_ADDRESS,
      zeroForOne: true,
      exactAmount: usdcRawFromUsd(amountUsd),
    });
    const result = await ethCall(
      rpcUrl,
      MONAD_UNISWAP_V4_QUOTER,
      data
    );
    return result ? decodeAmountOut(result) : null;
  };

  let referenceOut: bigint | null = null;
  try {
    referenceOut = await quoteOut(REFERENCE_USD);
  } catch {
    // Individual quotes below will return their own status.
  }
  const referenceHuman =
    referenceOut != null && referenceOut > BigInt(0)
      ? rawToNumber(referenceOut, cbBtc.decimals)
      : 0;
  const referencePrice =
    referenceHuman > 0 ? REFERENCE_USD / referenceHuman : null;

  const quotes: SizeQuote[] = [];
  for (const amountUsd of COMPARE_AMOUNTS_USD) {
    try {
      const amountOut = await quoteOut(amountUsd);
      if (amountOut == null || amountOut <= BigInt(0)) {
        quotes.push({
          amountUsd,
          amountOut: null,
          amountOutHuman: null,
          priceImpactPct: null,
          slippageBps: null,
          status: "na",
          note: "Uniswap V4 USDC/cbBTC quote unavailable",
        });
        continue;
      }

      const outHuman = rawToNumber(amountOut, cbBtc.decimals);
      const executionPrice = outHuman > 0 ? amountUsd / outHuman : null;
      const slippageBps = buySlippageBps(
        executionPrice,
        referencePrice
      );
      quotes.push({
        amountUsd,
        amountOut: amountOut.toString(),
        amountOutHuman: formatOutAmount(
          amountOut,
          cbBtc.decimals,
          cbBtc.symbol
        ),
        priceImpactPct:
          slippageBps != null ? slippageBps / 100 : null,
        slippageBps,
        status: "ok",
        note:
          `Uniswap V4 USDC/cbBTC 0.05% pool ${MONAD_UNISWAP_V4_CBBTC_POOL_ID}; ` +
          `buy slippage vs $${REFERENCE_USD} reference quote`,
      });
    } catch (err) {
      quotes.push({
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "error",
        note: err instanceof Error ? err.message : "Uniswap V4 quote failed",
      });
    }
  }

  return {
    venueId,
    venueName,
    section: "monad",
    quotes,
  };
}

export async function quoteMonadUniswapV3(
  tokenOut: CompareTokenOut,
  rpcUrl: string,
  quoter: string,
  venueId: string,
  venueName: string
): Promise<VenueQuoteRow> {
  if (tokenOut === "cbBTC") {
    return quoteMonadV4CbBtc(rpcUrl, venueId, venueName);
  }
  if (tokenOut === "XAUT0") {
    return stubMonadVenue(
      venueId,
      venueName,
      "No direct Uniswap USDC/XAUT0 pool; listed V4 pools use AUSD or USDT0"
    );
  }

  const meta = COMPARE_TOKENS[tokenOut];

  // Uniswap/Pancake: USDC→WMON (same as MON for compare).
  const tokenOutAddress = tokenOut === "MON" ? WMON_ADDRESS : meta.monadAddress;
  const note = tokenOut === "MON" ? "WMON/USDC on Monad (≈ MON)" : undefined;

  const row = await quoteUniswapStyle({
    venueId,
    venueName,
    section: "monad",
    rpcUrl,
    quoter,
    tokenIn: MONAD_USDC,
    tokenOutAddress,
    tokenOut,
    outDecimals: meta.decimals,
    outSymbol: meta.symbol,
  });

  if (!note) return row;
  return {
    ...row,
    quotes: row.quotes.map((q) => ({
      ...q,
      note: q.note ? `${note}; ${q.note}` : note,
    })),
  };
}

function naVenue(
  params: {
    venueId: string;
    venueName: string;
    section: VenueSection;
    highlight?: boolean;
  },
  note: string
): VenueQuoteRow {
  return {
    venueId: params.venueId,
    venueName: params.venueName,
    section: params.section,
    highlight: params.highlight,
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

export function stubMonadVenue(venueId: string, venueName: string, note: string): VenueQuoteRow {
  return naVenue({ venueId, venueName, section: "monad" }, note);
}
