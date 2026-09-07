import "server-only";

import {
  applyExternalLiquidations,
  fetchBinanceVenue,
  fetchBybitVenue,
  fetchCoinbaseSpot,
  fetchCoinalyzeStatus,
  fetchCoinglassLiquidations,
  fetchGateVenue,
  fetchHyperliquidPerp,
  fetchOkxVenue,
  fetchZeroxClusters,
  fetchZeroxVolume24h,
} from "@/lib/mon-clusters/sources";
import type { MonClustersResponse, VenueRow } from "@/lib/mon-clusters/types";

const CACHE_TTL_MS = 15_000;

let cache: { at: number; data: MonClustersResponse } | null = null;
let inflight: Promise<MonClustersResponse> | null = null;

async function buildMonClusters(): Promise<MonClustersResponse> {
  const [
    coinbaseSpot,
    hyperliquid,
    clusters,
    hlVolume,
    okx,
    gate,
    binance,
    bybit,
    coinglass,
    coinalyze,
  ] = await Promise.all([
    fetchCoinbaseSpot(),
    fetchHyperliquidPerp(),
    fetchZeroxClusters(),
    fetchZeroxVolume24h(),
    fetchOkxVenue(),
    fetchGateVenue(),
    fetchBinanceVenue(),
    fetchBybitVenue(),
    fetchCoinglassLiquidations(),
    fetchCoinalyzeStatus(),
  ]);

  const hyperliquidVenue: VenueRow = hyperliquid.reason && hyperliquid.markUsd == null
    ? {
        id: "hyperliquid",
        name: "Hyperliquid",
        kind: "cluster",
        status: "unavailable",
        reason: hyperliquid.reason,
        markUsd: null,
        funding: null,
        oiUsd: null,
        liqLong24hUsd: null,
        liqShort24hUsd: null,
        longShortRatio: null,
        notes: null,
      }
    : {
        id: "hyperliquid",
        name: "Hyperliquid",
        kind: "cluster",
        status: "ok",
        reason: hyperliquid.reason,
        markUsd: hyperliquid.markUsd,
        funding: hyperliquid.funding,
        oiUsd: hyperliquid.oiUsd,
        liqLong24hUsd: hlVolume.longUsd,
        liqShort24hUsd: hlVolume.shortUsd,
        longShortRatio: null,
        notes: hlVolume.reason
          ? `Projected clusters via 0xArchive · 24h completed liquidations: ${hlVolume.reason}`
          : "Projected clusters via 0xArchive · 24h completed liquidations from 0xArchive volume",
      };

  const venues = applyExternalLiquidations(
    [hyperliquidVenue, okx, gate, binance, bybit],
    coinglass.byVenue
  );

  return {
    fetchedAt: new Date().toISOString(),
    prices: {
      coinbaseSpot,
      hyperliquidMark: {
        status: hyperliquid.markUsd != null ? "ok" : "unavailable",
        usd: hyperliquid.markUsd,
        reason: hyperliquid.reason,
      },
    },
    clusters,
    venues,
    aggregators: [coinglass.aggregator, coinalyze],
  };
}

export async function getMonClusters(forceRefresh = false): Promise<MonClustersResponse> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (!forceRefresh && inflight) {
    return inflight;
  }

  inflight = buildMonClusters()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
