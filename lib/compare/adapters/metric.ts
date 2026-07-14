import "server-only";

import { buySlippageBps } from "@/lib/compare/fill-book";
import { getMonadRpcUrl } from "@/lib/compare/rpc-urls";
import {
  COMPARE_AMOUNTS_USD,
  formatOutAmount,
  usdcRawFromUsd,
  type CompareTokenOut,
  type SizeQuote,
  type VenueQuoteRow,
} from "@/lib/compare/tokens";

const METRIC_QUOTE_REVERT_SELECTOR = "0xb3e8f9a9";
const RAW_QUOTE_SELECTOR = "0x43e280d4";
const GET_IMMUTABLES_SELECTOR = "0xbcdb4dad";
const GET_BID_ASK_SELECTOR = "0xc1701b67";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const MAX_UINT128 = (ONE << BigInt(128)) - ONE;

const USDC_DECIMALS = 6;
const USDC_SCALE = BigInt(10) ** BigInt(USDC_DECIMALS);

interface MetricMarket {
  address: string;
  baseDecimals: number;
  outputSymbol: string;
  note: string;
}

function marketForToken(tokenOut: CompareTokenOut): MetricMarket | null {
  switch (tokenOut) {
    case "MON":
      return {
        address: "0xfa32f9ec28787d1f9c5ba5c39e54e59984fef3f0",
        baseDecimals: 18,
        outputSymbol: "MON",
        note: "Metric WMON/USDC",
      };
    case "WETH":
      return {
        address: "0x354d92279ca0190ff275095fe6a2a6989baa66fb",
        baseDecimals: 18,
        outputSymbol: "WETH",
        note: "Metric WETH/USDC",
      };
    case "cbBTC":
      return {
        address: "0x2d82ac42334b394a9a8d8f097d61dc1c6b065fd8",
        baseDecimals: 8,
        outputSymbol: "WBTC",
        note: "Metric WBTC/USDC (mapped from cbBTC tab)",
      };
    case "XAUT0":
      return null;
  }
}

interface RpcResponse {
  result?: string;
  error?: { message?: string; data?: string | { data?: string } };
}

interface MetricQuote {
  amount0Delta: bigint;
  amount1Delta: bigint;
}

interface BidQuote {
  status: "full" | "partial" | "error";
  price: number | null;
}

interface AskQuote {
  status: "full" | "partial" | "error";
  requestedUsdcRaw: bigint;
  actualUsdcRaw: bigint;
  baseOutRaw: bigint;
  price: number | null;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function words(hex: string): string[] {
  const raw = strip0x(hex);
  if (raw.length % 64 !== 0) {
    throw new Error(`Metric payload is not word-aligned: ${raw.length}`);
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 64) {
    out.push(raw.slice(i, i + 64));
  }
  return out;
}

function wordToBigInt(word: string): bigint {
  return BigInt(`0x${word}`);
}

function wordToAddress(word: string): `0x${string}` {
  return `0x${word.slice(24)}`.toLowerCase() as `0x${string}`;
}

function unsignedToSigned(value: bigint, bits: number): bigint {
  const max = ONE << BigInt(bits);
  const sign = ONE << BigInt(bits - 1);
  return value >= sign ? value - max : value;
}

function wordToInt(word: string, bits = 256): bigint {
  return unsignedToSigned(wordToBigInt(word), bits);
}

function encodeWord(value: bigint | number): string {
  const n = BigInt(value);
  if (n < ZERO) throw new Error("encodeWord only accepts unsigned values");
  return n.toString(16).padStart(64, "0");
}

function encodeInt128(value: bigint): string {
  return value < ZERO ? encodeWord((ONE << BigInt(128)) + value) : encodeWord(value);
}

function decodeTwoSignedWords(output: string): MetricQuote | null {
  if (!output || output === "0x") return null;
  const allWords = words(output);
  if (allWords.length < 2) throw new Error("Metric quote returned fewer than two words");
  return {
    amount0Delta: wordToInt(allWords[0]),
    amount1Delta: wordToInt(allWords[1]),
  };
}

function decodeQuoteRevert(data: string): MetricQuote | null {
  if (data.slice(0, 10).toLowerCase() !== METRIC_QUOTE_REVERT_SELECTOR) {
    return null;
  }
  return decodeTwoSignedWords(`0x${strip0x(data).slice(8)}`);
}

function rpcErrorData(error: RpcResponse["error"]): string | null {
  if (!error?.data) return null;
  if (typeof error.data === "string") return error.data;
  return error.data.data ?? null;
}

function toDecimal(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function priceFromRaw(
  usdcRaw: bigint,
  baseRaw: bigint,
  baseDecimals: number
): number | null {
  if (baseRaw === ZERO) return null;
  return (
    toDecimal(usdcRaw, USDC_DECIMALS) /
    toDecimal(baseRaw, baseDecimals)
  );
}

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

async function postRpc(rpcUrl: string, body: object, timeoutMs = 5_000): Promise<RpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Metric RPC HTTP ${response.status}`);
    }
    return (await response.json()) as RpcResponse;
  } finally {
    clearTimeout(timeout);
  }
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const response = await postRpc(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  if (response.error || !response.result) {
    throw new Error(response.error?.message || "Metric eth_call failed");
  }
  return response.result;
}

async function rawQuote(
  rpcUrl: string,
  marketAddress: string,
  {
    zeroForOne,
    amountSpecified,
    sqrtPriceLimitX128,
    bid,
    ask,
  }: {
    zeroForOne: boolean;
    amountSpecified: bigint;
    sqrtPriceLimitX128: bigint;
    bid: bigint;
    ask: bigint;
  }
): Promise<MetricQuote | null> {
  const data =
    RAW_QUOTE_SELECTOR +
    encodeWord(zeroForOne ? ONE : ZERO) +
    encodeInt128(amountSpecified) +
    encodeWord(sqrtPriceLimitX128) +
    encodeWord(bid) +
    encodeWord(ask);

  const response = await postRpc(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: marketAddress, data }, "latest"],
  });

  if (response.error) {
    const errData = rpcErrorData(response.error);
    if (errData) return decodeQuoteRevert(errData);
    throw new Error(response.error.message || "Metric raw quote failed");
  }

  return response.result ? decodeTwoSignedWords(response.result) : null;
}

async function getPriceProvider(
  rpcUrl: string,
  marketAddress: string
): Promise<`0x${string}`> {
  const output = await ethCall(
    rpcUrl,
    marketAddress,
    GET_IMMUTABLES_SELECTOR
  );
  const allWords = words(output);
  if (allWords.length < 2) throw new Error("Metric getImmutables returned too few words");
  return wordToAddress(allWords[1]);
}

async function getBidAsk(
  rpcUrl: string,
  priceProvider: string
): Promise<{ bid: bigint; ask: bigint }> {
  const output = await ethCall(rpcUrl, priceProvider, GET_BID_ASK_SELECTOR);
  const [bidWord, askWord] = words(output);
  return {
    bid: wordToBigInt(bidWord),
    ask: wordToBigInt(askWord),
  };
}

async function quoteBid(
  rpcUrl: string,
  market: MetricMarket,
  bidAsk: { bid: bigint; ask: bigint },
  targetBaseRaw: bigint
): Promise<BidQuote> {
  const output = await rawQuote(rpcUrl, market.address, {
    zeroForOne: true,
    amountSpecified: targetBaseRaw,
    sqrtPriceLimitX128: ZERO,
    bid: bidAsk.bid,
    ask: bidAsk.ask,
  });
  if (!output) {
    return { status: "error", price: null };
  }

  const actualBaseRaw = abs(output.amount0Delta);
  const usdcOutRaw = abs(output.amount1Delta);
  return {
    status: actualBaseRaw === targetBaseRaw ? "full" : "partial",
    price: priceFromRaw(
      usdcOutRaw,
      actualBaseRaw,
      market.baseDecimals
    ),
  };
}

async function quoteAskForUsdc(
  rpcUrl: string,
  market: MetricMarket,
  bidAsk: { bid: bigint; ask: bigint },
  usdcRaw: bigint
): Promise<AskQuote> {
  const output = await rawQuote(rpcUrl, market.address, {
    zeroForOne: false,
    amountSpecified: usdcRaw,
    sqrtPriceLimitX128: MAX_UINT128,
    bid: bidAsk.bid,
    ask: bidAsk.ask,
  });
  if (!output) {
    return {
      status: "error",
      requestedUsdcRaw: usdcRaw,
      actualUsdcRaw: ZERO,
      baseOutRaw: ZERO,
      price: null,
    };
  }

  const baseOutRaw = abs(output.amount0Delta);
  const actualUsdcRaw = abs(output.amount1Delta);
  return {
    status: actualUsdcRaw === usdcRaw ? "full" : "partial",
    requestedUsdcRaw: usdcRaw,
    actualUsdcRaw,
    baseOutRaw,
    price: priceFromRaw(
      actualUsdcRaw,
      baseOutRaw,
      market.baseDecimals
    ),
  };
}

function naMetricRow(note: string): VenueQuoteRow {
  return {
    venueId: "metric-monad",
    venueName: "Metric",
    section: "monad",
    quotes: COMPARE_AMOUNTS_USD.map((amountUsd) => ({
      amountUsd,
      amountOut: null,
      amountOutHuman: null,
      priceImpactPct: null,
      slippageBps: null,
      status: "na" as const,
      note,
    })),
  };
}

/** Metric one-hop quotes via each Monad market's on-chain rawQuote. */
export async function quoteMetric(tokenOut: CompareTokenOut): Promise<VenueQuoteRow> {
  const market = marketForToken(tokenOut);
  if (!market) {
    return naMetricRow(
      "Metric has no XAUT0/USDC market on Monad"
    );
  }

  let rpcUrl: string;
  try {
    rpcUrl = getMonadRpcUrl();
  } catch {
    return naMetricRow("MONAD_RPC_URL not configured");
  }

  try {
    const priceProvider = await getPriceProvider(
      rpcUrl,
      market.address
    );
    const bidAsk = await getBidAsk(rpcUrl, priceProvider);
    const baseScale = BigInt(10) ** BigInt(market.baseDecimals);
    const [tinyBid, tinyAsk] = await Promise.all([
      quoteBid(rpcUrl, market, bidAsk, ONE * baseScale),
      quoteAskForUsdc(rpcUrl, market, bidAsk, ONE * USDC_SCALE),
    ]);

    if (tinyBid.price === null || tinyAsk.price === null) {
      return naMetricRow("Metric did not return executable top-of-book quotes");
    }

    const midPrice = (tinyBid.price + tinyAsk.price) / 2;
    const asks = await Promise.all(
      COMPARE_AMOUNTS_USD.map((amountUsd) =>
        quoteAskForUsdc(
          rpcUrl,
          market,
          bidAsk,
          usdcRawFromUsd(amountUsd)
        )
      )
    );

    const quotes: SizeQuote[] = COMPARE_AMOUNTS_USD.map((amountUsd, index) => {
      const ask = asks[index];
      if (
        !ask ||
        ask.status !== "full" ||
        ask.baseOutRaw <= ZERO ||
        ask.price === null
      ) {
        return {
          amountUsd,
          amountOut: null,
          amountOutHuman: null,
          priceImpactPct: null,
          slippageBps: null,
          status: "na" as const,
          note:
            ask?.status === "partial"
              ? `Metric cannot fully fill $${amountUsd.toLocaleString()}`
              : "Metric rawQuote miss",
        };
      }

      const slippage = buySlippageBps(ask.price, midPrice);

      return {
        amountUsd,
        amountOut: ask.baseOutRaw.toString(),
        amountOutHuman: formatOutAmount(
          ask.baseOutRaw,
          market.baseDecimals,
          market.outputSymbol
        ),
        priceImpactPct: slippage != null ? slippage / 100 : null,
        slippageBps: slippage,
        status: "ok" as const,
        note: `${market.note}; buy slippage vs mid`,
      };
    });

    return {
      venueId: "metric-monad",
      venueName: "Metric",
      section: "monad",
      quotes,
    };
  } catch (err) {
    return naMetricRow(err instanceof Error ? err.message : "Metric quote failed");
  }
}
