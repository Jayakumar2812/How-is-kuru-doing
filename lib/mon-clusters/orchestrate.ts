import "server-only";

import {
  applyExternalLiquidations,
  fetchBinanceVenue,
  fetchBitgetVenue,
  fetchBybitVenue,
  fetchCoinbaseSpot,
  fetchCoinalyzeStatus,
  fetchCoinglassClusterSeries,
  fetchCoinglassLiquidations,
  fetchGateVenue,
  fetchHyperliquidPerp,
  fetchOkxVenue,
  fetchZeroxClusterSeries,
  fetchZeroxVolume24h,
  mergeClusterSeries,
} from "@/lib/mon-clusters/sources";
import type { ClusterSeries, ExchangeId, MonClustersResponse, VenueRow } from "@/lib/mon-clusters/types";

const CACHE_TTL_MS = 15_000;
const CEX_ORDER: ExchangeId[] = ["binance", "bybit", "okx", "bitget", "hyperliquid"];

let cache: { at: number; data: MonClustersResponse } | null = null;
let inflight: Promise<MonClustersResponse> | null = null;

function sortSeries(series: ClusterSeries[]): ClusterSeries[] {
  return [...series].sort((a, b) => CEX_ORDER.indexOf(a.id) - CEX_ORDER.indexOf(b.id));
}

async function buildMonClusters(): Promise<MonClustersResponse> {
  const [coinbaseSpot, hyperliquid, okx, gate, binance, bybit, bitget] = await Promise.all([
    fetchCoinbaseSpot(),
    fetchHyperliquidPerp(),
    fetchOkxVenue(),
    fetchGateVenue(),
    fetchBinanceVenue(),
    fetchBybitVenue(),
    fetchBitgetVenue(),
  ]);

  const fallbackMark =
    coinbaseSpot.usd ??
    hyperliquid.markUsd ??
    okx.markUsd ??
    bitget.markUsd ??
    gate.markUsd ??
    binance.markUsd ??
    bybit.markUsd ??
    null;

  const marks: Partial<Record<ExchangeId, number | null>> = {
    binance: binance.markUsd ?? fallbackMark,
    bybit: bybit.markUsd ?? fallbackMark,
    okx: okx.markUsd ?? fallbackMark,
    bitget: bitget.markUsd ?? fallbackMark,
    hyperliquid: hyperliquid.markUsd ?? fallbackMark,
    gate: gate.markUsd ?? fallbackMark,
  };

  const [hlSeries, hlVolume, coinglassClusters, coinglassLiqs, coinalyze] = await Promise.all([
    fetchZeroxClusterSeries(),
    fetchZeroxVolume24h(),
    fetchCoinglassClusterSeries(marks),
    fetchCoinglassLiquidations(),
    fetchCoinalyzeStatus(),
  ]);

  const seriesById = new Map<ExchangeId, ClusterSeries>();
  for (const item of coinglassClusters.series) {
    seriesById.set(item.id, item);
  }
  seriesById.set("hyperliquid", mergeClusterSeries(hlSeries, seriesById.get("hyperliquid")));

  const series = sortSeries([...seriesById.values()]);
  const ready = series.filter((item) => item.status === "ok" && item.levels.length > 0);
  const needsApiKey = series.some((item) => item.needsApiKey) && ready.length === 0;

  const hyperliquidVenue: VenueRow =
    hyperliquid.reason && hyperliquid.markUsd == null
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
            ? `Extra venue · 24h completed liquidations: ${hlVolume.reason}`
            : "Extra venue · 24h completed liquidations from 0xArchive volume",
        };

  const venues = applyExternalLiquidations(
    [binance, bybit, okx, bitget, hyperliquidVenue, gate],
    coinglassLiqs.byVenue
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
    clusters: {
      series,
      needsApiKey,
      note: needsApiKey
        ? "Cross-exchange price-level clusters come from CoinGlass heatmaps (Binance, Bybit, OKX, Bitget). Set COINGLASS_API_KEY. Hyperliquid source-split clusters can also use ZEROX_ARCHIVE_API_KEY."
        : ready.length
          ? "CoinGlass heatmap density is mark-implied (below mark = longs, above = shorts). Hyperliquid 0xArchive levels are source-split when present."
          : series.find((item) => item.reason)?.reason ?? "No cluster series returned.",
    },
    venues,
    aggregators: [coinglassClusters.aggregator, coinglassLiqs.aggregator, coinalyze],
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
