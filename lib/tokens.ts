export const USDC_ADDRESS = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
export const WETH_ADDRESS = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";
export const WBTC_ADDRESS = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
export const CBBTC_ADDRESS = "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b";
export const XAUT0_ADDRESS = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
export const WMON_ADDRESS = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

const KNOWN_TOKENS: Record<string, TokenMeta> = {
  [USDC_ADDRESS]: { symbol: "USDC", decimals: 6 },
  [NATIVE_ADDRESS]: { symbol: "MON", decimals: 18 },
  [WETH_ADDRESS]: { symbol: "WETH", decimals: 18 },
  [WBTC_ADDRESS]: { symbol: "WBTC", decimals: 8 },
  [CBBTC_ADDRESS]: { symbol: "cbBTC", decimals: 8 },
  [XAUT0_ADDRESS]: { symbol: "XAUT0", decimals: 6 },
  [WMON_ADDRESS]: { symbol: "WMON", decimals: 18 },
};

export function getTokenMeta(address: string): TokenMeta {
  const key = address.toLowerCase();
  if (KNOWN_TOKENS[key]) return KNOWN_TOKENS[key];
  return { symbol: `${key.slice(0, 6)}…${key.slice(-4)}`, decimals: 18 };
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  const negative = raw < BigInt(0);
  const abs = negative ? -raw : raw;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const formatted = fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
  return negative ? `-${formatted}` : formatted;
}

function parseAmountString(amount: string): number {
  return Number.parseFloat(amount.replace(/,/g, ""));
}

function trimTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function formatSmallAmount(absNum: number, symbol: string): string {
  const maxDecimals = symbol === "USDC" ? 2 : symbol === "MON" ? 4 : 2;
  return trimTrailingZeros(absNum.toFixed(maxDecimals));
}

function formatScaledAmount(value: number, unit: "k" | "mil" | "bil", withDecimal: boolean): string {
  if (withDecimal && value < 100) {
    return `${trimTrailingZeros(value.toFixed(1))}${unit === "k" ? "k" : ` ${unit}`}`;
  }
  const rounded = Math.round(value);
  return `${rounded}${unit === "k" ? "k" : ` ${unit}`}`;
}

/** Human-readable shorthand: 10.8k, 100k, 1.2 mil. Keeps decimals for USDC/MON. */
export function formatCompactTokenAmount(amount: string, symbol: string): string {
  const num = parseAmountString(amount);
  if (!Number.isFinite(num) || num === 0) return "0";

  const negative = num < 0;
  const absNum = Math.abs(num);
  const withDecimal = symbol === "USDC" || symbol === "MON";

  let compact: string;
  if (absNum >= 1_000_000_000) {
    compact = formatScaledAmount(absNum / 1_000_000_000, "bil", withDecimal);
  } else if (absNum >= 1_000_000) {
    compact = formatScaledAmount(absNum / 1_000_000, "mil", withDecimal);
  } else if (absNum >= 1_000) {
    compact = formatScaledAmount(absNum / 1_000, "k", withDecimal);
  } else {
    compact = formatSmallAmount(absNum, symbol);
  }

  return negative ? `-${compact}` : compact;
}

export function formatCompactFlowLabel(
  amount: string,
  symbol: string,
  direction: "in" | "out",
): string {
  return `${formatCompactTokenAmount(amount, symbol)} ${symbol} ${direction}`;
}

export function formatCompactNetLabel(amount: string, symbol: string): string {
  const num = parseAmountString(amount);
  const compact = formatCompactTokenAmount(amount, symbol);
  if (num > 0) return `+${compact} ${symbol}`;
  return `${compact} ${symbol}`;
}
