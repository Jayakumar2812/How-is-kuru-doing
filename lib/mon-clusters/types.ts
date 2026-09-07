export type SourceStatus = "ok" | "unavailable";
export type ExchangeId = "binance" | "bybit" | "okx" | "bitget" | "hyperliquid" | "gate";
export type SideSplit = "source" | "mark-implied";

export interface ClusterLevel {
  price: number;
  longNotionalUsd: number;
  shortNotionalUsd: number;
  notionalUsd: number;
  exchangeId: ExchangeId;
  exchangeName: string;
  source: string;
}

export interface ClusterSeries {
  id: ExchangeId;
  name: string;
  status: SourceStatus;
  reason: string | null;
  needsApiKey: boolean;
  source: string | null;
  sideSplit: SideSplit | null;
  midPrice: number | null;
  levels: ClusterLevel[];
}

export interface ClustersPayload {
  series: ClusterSeries[];
  needsApiKey: boolean;
  note: string;
}

export interface PriceQuote {
  status: SourceStatus;
  usd: number | null;
  reason: string | null;
}

export interface VenueRow {
  id: ExchangeId;
  name: string;
  kind: "cluster" | "summary";
  status: SourceStatus;
  reason: string | null;
  markUsd: number | null;
  funding: number | null;
  oiUsd: number | null;
  liqLong24hUsd: number | null;
  liqShort24hUsd: number | null;
  longShortRatio: number | null;
  notes: string | null;
}

export interface AggregatorStatus {
  id: string;
  name: string;
  status: SourceStatus;
  reason: string | null;
}

export interface MonClustersResponse {
  fetchedAt: string;
  prices: {
    coinbaseSpot: PriceQuote;
    hyperliquidMark: PriceQuote;
  };
  clusters: ClustersPayload;
  venues: VenueRow[];
  aggregators: AggregatorStatus[];
}
