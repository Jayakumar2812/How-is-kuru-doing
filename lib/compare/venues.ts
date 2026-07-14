import type { CompareTokenOut, VenueSection } from "@/lib/compare/tokens";

export interface VenueDef {
  id: string;
  name: string;
  section: VenueSection;
  highlight?: boolean;
  /** DefiLlama protocol name fragments for ranking */
  llamaNames?: string[];
}

export const MONAD_VENUES: VenueDef[] = [
  { id: "kuru", name: "Kuru", section: "monad", highlight: true, llamaNames: ["Kuru"] },
  { id: "uniswap-monad", name: "Uniswap", section: "monad", llamaNames: ["Uniswap V3", "Uniswap V2", "Uniswap"] },
  { id: "lfj-monad", name: "LFJ", section: "monad", llamaNames: ["Joe V2.2", "Joe V2.1", "LFJ"] },
  { id: "metric-monad", name: "Metric", section: "monad", llamaNames: ["Metric"] },
  { id: "balancer-monad", name: "Balancer", section: "monad", llamaNames: ["Balancer"] },
  { id: "clober-monad", name: "Clober", section: "monad", llamaNames: ["Clober V2", "Clober"] },
  { id: "mento-monad", name: "Mento", section: "monad", llamaNames: ["Mento V3", "Mento"] },
];

export const REST_VENUES: VenueDef[] = [
  { id: "jupiter-sol", name: "Jupiter (Solana)", section: "rest" },
  { id: "hyperliquid", name: "Hyperliquid", section: "rest" },
  { id: "coinbase", name: "Coinbase", section: "rest" },
  { id: "binance", name: "Binance", section: "rest" },
  { id: "okx", name: "OKX", section: "rest" },
  { id: "bybit", name: "Bybit", section: "rest" },
  { id: "lighter", name: "Lighter", section: "rest" },
];

/** Kuru market symbols for depth API (USDC quote markets). */
export const KURU_DEPTH_SYMBOLS: Partial<Record<CompareTokenOut, string>> = {
  MON: "MON_USDC",
  WETH: "WETH_USDC",
  cbBTC: "CBBTC_USDC",
  XAUT0: "XAUT0_USDC",
};

/** Kuru orderbook markets (USDC quote) — one-hop placeAndExecuteMarketBuy. */
export const KURU_MARKETS: Record<CompareTokenOut, string> = {
  MON: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
  WETH: "0xa6afd386135b7d41a6c40c525abc4a1019b0d132",
  cbBTC: "0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0",
  XAUT0: "0x851145eaefdc37956b08da829fa31722199f3f07",
};

/** Official Uniswap V3 Quoter on Monad mainnet (chain 143). */
export const MONAD_UNISWAP_QUOTER = "0x2d01411773c8c24805306e89a41f7855c3c4fe65";

/** Official Uniswap V4 Quoter on Monad mainnet. */
export const MONAD_UNISWAP_V4_QUOTER =
  "0xa222dd357a9076d1091ed6aa2e16c9742dd26891";

/** Canonical V4 USDC/cbBTC pool: 0.05%, tick spacing 10, no hooks. */
export const MONAD_UNISWAP_V4_CBBTC_POOL_ID =
  "0x7fc6232a9ec6cc4e9434640dcde5ee08ccae3b07de3247bf788fc9e2051b449e";

export const FEE_TIERS = [100, 500, 3000, 10000] as const;

export const SOL_MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL: "So11111111111111111111111111111111111111112",
  /** Wormhole / NTT WMON on Solana — https://docs.monad.xyz */
  WMON: "CrAr4RRJMBVwRsZtT62pEhfA9H5utymC2mVx8e7FreP2",
  /** Ether (Portal) on Solana; Jupiter symbol is ETH */
  WETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  WBTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  XAUT0: "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P",
} as const;
