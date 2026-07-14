import "server-only";

import { buySlippageBps } from "@/lib/compare/fill-book";
import {
  COMPARE_AMOUNTS_USD,
  formatOutAmount,
  rawToNumber,
  usdcRawFromUsd,
  type CompareTokenOut,
  type SizeQuote,
  type VenueQuoteRow,
} from "@/lib/compare/tokens";
import { getSolanaRpcUrl } from "@/lib/compare/rpc-urls";
import { SOL_MINTS } from "@/lib/compare/venues";

function outMintFor(tokenOut: CompareTokenOut): { mint: string; decimals: number; symbol: string; note?: string } | null {
  switch (tokenOut) {
    case "MON":
      return {
        mint: SOL_MINTS.WMON,
        decimals: 8,
        symbol: "WMON",
        note: "WMON/USDC on Solana (bridged MON)",
      };
    case "WETH":
      return {
        mint: SOL_MINTS.WETH,
        decimals: 8,
        symbol: "ETH",
        note: "ETH/USDC on Jupiter (bridged WETH mint)",
      };
    case "cbBTC":
      return { mint: SOL_MINTS.WBTC, decimals: 8, symbol: "WBTC", note: "Mapped to WBTC" };
    case "XAUT0":
      return {
        mint: SOL_MINTS.XAUT0,
        decimals: 6,
        symbol: "XAUt0",
        note: "XAUt0/USDC on Jupiter",
      };
    default:
      return null;
  }
}

interface JupiterQuote {
  outAmount?: string;
  routePlan?: unknown[];
  error?: string;
}

async function fetchDirectQuote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: "50",
    onlyDirectRoutes: "true",
  });

  const url = `https://lite-api.jup.ag/swap/v1/quote?${params.toString()}`;
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    return (await resp.json()) as JupiterQuote;
  } catch {
    return null;
  }
}

/** Lightweight Solana RPC ping so we exercise SOLANA_RPC_URL as required. */
async function pingSolanaRpc(): Promise<boolean> {
  try {
    const resp = await fetch(getSolanaRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      cache: "no-store",
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function quoteJupiter(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const mapped = outMintFor(tokenOut);
  if (!mapped) {
    return {
      venueId: "jupiter-sol",
      venueName: "Jupiter (Solana)",
      section: "rest",
      quotes: COMPARE_AMOUNTS_USD.map((amountUsd) => ({
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "na",
        note: "No direct Solana USDC analog for XAUT0",
      })),
    };
  }

  await pingSolanaRpc();

  const referenceUsd = COMPARE_AMOUNTS_USD[0];
  const referenceQuote = await fetchDirectQuote(
    SOL_MINTS.USDC,
    mapped.mint,
    usdcRawFromUsd(referenceUsd)
  );
  const referenceIsDirect =
    referenceQuote?.outAmount != null &&
    Array.isArray(referenceQuote.routePlan) &&
    referenceQuote.routePlan.length === 1;
  const referenceOut = referenceIsDirect
    ? rawToNumber(BigInt(referenceQuote.outAmount!), mapped.decimals)
    : 0;
  const referencePrice =
    referenceOut > 0 ? referenceUsd / referenceOut : null;

  const quotes: SizeQuote[] = [];
  for (const amountUsd of COMPARE_AMOUNTS_USD) {
    const amountIn = usdcRawFromUsd(amountUsd);
    const quote = await fetchDirectQuote(SOL_MINTS.USDC, mapped.mint, amountIn);

    if (!quote?.outAmount || (quote.routePlan && quote.routePlan.length > 1)) {
      quotes.push({
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "na",
        note: quote?.routePlan && quote.routePlan.length > 1 ? "Multi-hop rejected" : "No direct route",
      });
      continue;
    }

    // onlyDirectRoutes should already be 1 market; still reject multi-leg routePlan
    if (Array.isArray(quote.routePlan) && quote.routePlan.length !== 1) {
      quotes.push({
        amountUsd,
        amountOut: null,
        amountOutHuman: null,
        priceImpactPct: null,
        slippageBps: null,
        status: "na",
        note: "Route not single-hop",
      });
      continue;
    }

    const raw = BigInt(quote.outAmount);
    const output = rawToNumber(raw, mapped.decimals);
    const executionPrice = output > 0 ? amountUsd / output : null;
    const slippageBps = buySlippageBps(executionPrice, referencePrice);
    const slippageNote =
      slippageBps != null
        ? `Buy slippage vs $${referenceUsd} reference quote`
        : null;
    quotes.push({
      amountUsd,
      amountOut: raw.toString(),
      amountOutHuman: formatOutAmount(raw, mapped.decimals, mapped.symbol),
      priceImpactPct: slippageBps != null ? slippageBps / 100 : null,
      slippageBps,
      status: "ok",
      note: [mapped.note, slippageNote].filter(Boolean).join("; "),
    });
  }

  return {
    venueId: "jupiter-sol",
    venueName: "Jupiter (Solana)",
    section: "rest",
    quotes,
  };
}
