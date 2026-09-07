export type SourceStatus = "ok" | "unavailable";

export interface ClusterLevel {
  price: number;
  longNotionalUsd: number;
  shortNotionalUsd: number;
  longCount: number | null;
  shortCount: number | null;
  source: string;
}

export interface ClusterPayload {
  status: SourceStatus;
  reason: string | null;
  needsApiKey: boolean;
  midPrice: number | null;
  snapshotTs: string | null;
  totalLongUsd: number | null;
  totalShortUsd: number | null;
  levels: ClusterLevel[];
}

export interface PriceQuote {
  status: SourceStatus;
  usd: number | null;
  reason: string | null;
}

export interface VenueRow {
  id: string;
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
  clusters: ClusterPayload;
  venues: VenueRow[];
  aggregators: AggregatorStatus[];
}
