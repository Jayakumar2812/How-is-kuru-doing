export interface BlockStatus {
  number: number;
  hasKuru: boolean;
  viaTrace: boolean;
  viaTx: boolean;
  timestamp: number;
}

export interface KuruWindowResponse {
  latestBlock: number;
  fromBlock: number;
  count: number;
  blocks: BlockStatus[];
  activeCount: number;
  activePct: number;
  cached?: boolean;
  stale?: boolean;
  scannedAt?: string;
}

export interface TokenFlow {
  address: string;
  symbol: string;
  decimals: number;
  inflow: string;
  outflow: string;
  net: string;
  depositCount: number;
  withdrawalCount: number;
}

export interface MarginFlowsResponse {
  utcWindow: {
    dateKey: string;
    start: string;
    end: string;
    label: string;
  };
  blockRange: { from: number; to: number };
  tokens: TokenFlow[];
  defaultToken: string;
  cached: boolean;
  scannedAt: string;
}

export type {
  CompareQuotesResponse,
  CompareTokenOut,
  VenueQuoteRow,
} from "@/lib/compare/tokens";

