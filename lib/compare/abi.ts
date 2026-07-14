import "server-only";

/** Minimal ABI helpers for QuoterV2.quoteExactInputSingle eth_call (no viem). */

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function pad32(hex: string): string {
  return strip0x(hex).toLowerCase().padStart(64, "0");
}

function encodeAddress(addr: string): string {
  return pad32(addr);
}

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeUint24(value: number): string {
  return value.toString(16).padStart(64, "0");
}

/** selector = keccak256("quoteExactInputSingle((address,address,uint256,uint24,uint160))")[:4] */
const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "c6a5026a";

export function encodeQuoteExactInputSingle(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  fee: number;
  sqrtPriceLimitX96?: bigint;
}): `0x${string}` {
  // Static tuple args encode inline (no dynamic offset head).
  const tuple =
    encodeAddress(params.tokenIn) +
    encodeAddress(params.tokenOut) +
    encodeUint256(params.amountIn) +
    encodeUint24(params.fee) +
    encodeUint256(params.sqrtPriceLimitX96 ?? BigInt(0));

  return `0x${QUOTE_EXACT_INPUT_SINGLE_SELECTOR}${tuple}`;
}

/** selector = keccak256("quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))")[:4] */
const V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "aa9d21cb";

export function encodeV4QuoteExactInputSingle(params: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  zeroForOne: boolean;
  exactAmount: bigint;
}): `0x${string}` {
  if (params.tickSpacing < 0) {
    throw new Error("Negative V4 tick spacing is not supported");
  }

  // The outer argument is dynamic because QuoteExactSingleParams contains bytes hookData.
  const tuple =
    encodeAddress(params.currency0) +
    encodeAddress(params.currency1) +
    encodeUint24(params.fee) +
    encodeUint24(params.tickSpacing) +
    encodeAddress(params.hooks) +
    encodeUint256(params.zeroForOne ? BigInt(1) : BigInt(0)) +
    encodeUint256(params.exactAmount) +
    encodeUint256(BigInt(256)) + // hookData offset from tuple start (8 words)
    encodeUint256(BigInt(0)); // empty hookData length

  return `0x${V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR}${encodeUint256(BigInt(32))}${tuple}`;
}

/** Decode first uint256 return (amountOut) from QuoterV2 response. */
export function decodeAmountOut(resultHex: string): bigint | null {
  const hex = strip0x(resultHex);
  if (hex.length < 64) return null;
  try {
    return BigInt(`0x${hex.slice(0, 64)}`);
  } catch {
    return null;
  }
}

export async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
  from?: string
): Promise<string | null> {
  const tx: { to: string; data: string; from?: string } = { to, data };
  if (from) tx.from = from;

  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [tx, "latest"],
    }),
    cache: "no-store",
  });

  if (!resp.ok) return null;
  const body = (await resp.json()) as { result?: string; error?: { message: string } };
  if (body.error || !body.result || body.result === "0x") return null;
  return body.result;
}

/** selector = placeAndExecuteMarketBuy(uint96,uint256,bool,bool) */
const KURU_MARKET_BUY_SELECTOR = "7c51d6cf";

export function encodeKuruMarketBuy(quoteSize: bigint, minOut = BigInt(0)): `0x${string}` {
  return `0x${KURU_MARKET_BUY_SELECTOR}${encodeUint256(quoteSize)}${encodeUint256(minOut)}${encodeUint256(BigInt(0))}${encodeUint256(BigInt(0))}`;
}

/** selector = getMarketParams() */
const KURU_GET_MARKET_PARAMS_SELECTOR = "90c9427c";

export function encodeKuruGetMarketParams(): `0x${string}` {
  return `0x${KURU_GET_MARKET_PARAMS_SELECTOR}`;
}

export interface KuruMarketParams {
  pricePrecision: bigint;
  sizePrecision: bigint;
  baseAssetDecimals: number;
  quoteAssetDecimals: number;
}

/** Decode getMarketParams return (matches Kuru SDK ParamFetcher field order). */
export function decodeKuruMarketParams(resultHex: string): KuruMarketParams | null {
  const hex = strip0x(resultHex);
  // 11 × 32-byte words (makerFeeBps may be present); need at least pricePrecision + base decimals.
  if (hex.length < 10 * 64) return null;
  try {
    const word = (i: number) => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`);
    const pricePrecision = word(0);
    const sizePrecision = word(1);
    const baseAssetDecimals = Number(word(3));
    const quoteAssetDecimals = Number(word(5));
    if (pricePrecision <= BigInt(0) || !Number.isFinite(baseAssetDecimals)) return null;
    return { pricePrecision, sizePrecision, baseAssetDecimals, quoteAssetDecimals };
  } catch {
    return null;
  }
}
