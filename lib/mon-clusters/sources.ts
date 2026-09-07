import "server-only";

import { fetchJson, finiteNumber, sleep, type HttpResult } from "@/lib/mon-clusters/http";
import type {
  AggregatorStatus,
  ClusterLevel,
  ClusterSeries,
  ExchangeId,
  PriceQuote,
  VenueRow,
} from "@/lib/mon-clusters/types";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const ZEROX_LEVELS_URL = "https://api.0xarchive.io/v1/hyperliquid/liquidations/MON/levels";
const ZEROX_VOLUME_URL = "https://api.0xarchive.io/v1/hyperliquid/liquidations/MON/volume";
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/MON-USD/spot";
const COINGLASS_BASE = "https://open-api-v4.coinglass.com";

const CLUSTER_EXCHANGES: Array<{
  id: Exclude<ExchangeId, "gate">;
  name: string;
  cgName: string;
  symbols: string[];
}> = [
  { id: "binance", name: "Binance", cgName: "Binance", symbols: ["MONUSDT"] },
  { id: "bybit", name: "Bybit", cgName: "Bybit", symbols: ["MONUSDT"] },
  { id: "okx", name: "OKX", cgName: "OKX", symbols: ["MON-USDT-SWAP", "MONUSDT"] },
  { id: "bitget", name: "Bitget", cgName: "Bitget", symbols: ["MONUSDT"] },
  { id: "hyperliquid", name: "Hyperliquid", cgName: "Hyperliquid", symbols: ["MONUSDT", "MON"] },
];

function unavailableVenue(id: ExchangeId, name: string, kind: VenueRow["kind"], reason: string): VenueRow {
  return {
    id,
    name,
    kind,
    status: "unavailable",
    reason,
    markUsd: null,
    funding: null,
    oiUsd: null,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio: null,
    notes: null,
  };
}

function unavailableSeries(
  id: ClusterSeries["id"],
  name: string,
  reason: string,
  needsApiKey: boolean
): ClusterSeries {
  return {
    id,
    name,
    status: "unavailable",
    reason,
    needsApiKey,
    source: null,
    sideSplit: null,
    midPrice: null,
    levels: [],
  };
}

function zeroxHeaders(): Record<string, string> | null {
  const key = process.env.ZEROX_ARCHIVE_API_KEY?.trim();
  if (!key) return null;
  return { "X-API-Key": key };
}

function coinglassHeaders(): Record<string, string> | null {
  const key = process.env.COINGLASS_API_KEY?.trim();
  if (!key) return null;
  return { "CG-API-KEY": key };
}

export async function fetchCoinbaseSpot(): Promise<PriceQuote> {
  const result = await fetchJson<{ data?: { amount?: string } }>(COINBASE_SPOT_URL);
  if (!result.ok) {
    return { status: "unavailable", usd: null, reason: result.reason };
  }
  const usd = finiteNumber(result.data.data?.amount);
  if (usd == null) {
    return { status: "unavailable", usd: null, reason: "Coinbase response had no spot amount" };
  }
  return { status: "ok", usd, reason: null };
}

interface HlMeta {
  universe?: Array<{ name?: string }>;
}

interface HlAssetCtx {
  funding?: string;
  openInterest?: string;
  markPx?: string;
  midPx?: string;
}

export interface HyperliquidPerp {
  markUsd: number | null;
  funding: number | null;
  oiBase: number | null;
  oiUsd: number | null;
  reason: string | null;
}

async function fetchHyperliquidInfo(): Promise<HttpResult<[HlMeta, HlAssetCtx[]]>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchJson<[HlMeta, HlAssetCtx[]]>(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      timeoutMs: 12_000,
    });
    if (result.ok) return result;
    if (result.status === 429 && attempt < 2) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    return result;
  }
  return { ok: false, status: 429, reason: "Rate limited (429)" };
}

export async function fetchHyperliquidPerp(): Promise<HyperliquidPerp> {
  const result = await fetchHyperliquidInfo();
  if (!result.ok) {
    return { markUsd: null, funding: null, oiBase: null, oiUsd: null, reason: result.reason };
  }

  const [meta, ctxs] = result.data;
  const universe = meta?.universe ?? [];
  const index = universe.findIndex((asset) => asset.name === "MON");
  if (index < 0 || !ctxs?.[index]) {
    return { markUsd: null, funding: null, oiBase: null, oiUsd: null, reason: "MON not found in Hyperliquid universe" };
  }

  const ctx = ctxs[index];
  const markUsd = finiteNumber(ctx.markPx) ?? finiteNumber(ctx.midPx);
  const funding = finiteNumber(ctx.funding);
  const oiBase = finiteNumber(ctx.openInterest);
  const oiUsd = markUsd != null && oiBase != null ? markUsd * oiBase : null;
  if (markUsd == null) {
    return { markUsd: null, funding, oiBase, oiUsd: null, reason: "Hyperliquid MON mark missing" };
  }
  return { markUsd, funding, oiBase, oiUsd, reason: null };
}

function applyMarkImpliedSides(levels: ClusterLevel[], mark: number | null): ClusterLevel[] {
  if (mark == null || mark <= 0) return levels;
  return levels.map((level) => {
    if (level.price < mark) {
      return { ...level, longNotionalUsd: level.notionalUsd, shortNotionalUsd: 0 };
    }
    if (level.price > mark) {
      return { ...level, longNotionalUsd: 0, shortNotionalUsd: level.notionalUsd };
    }
    return level;
  });
}

interface ZeroxLevel {
  price?: number;
  long_notional?: number;
  short_notional?: number;
  long_count?: number;
  short_count?: number;
}

interface ZeroxLevelsData {
  mid_price?: number;
  snapshot_ts?: string;
  total_long?: number;
  total_short?: number;
  levels?: ZeroxLevel[];
}

interface ZeroxEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

export async function fetchZeroxClusterSeries(): Promise<ClusterSeries> {
  const headers = zeroxHeaders();
  if (!headers) {
    return unavailableSeries(
      "hyperliquid",
      "Hyperliquid",
      "Set ZEROX_ARCHIVE_API_KEY for Hyperliquid source-split clusters, or COINGLASS_API_KEY for the multi-CEX heatmap.",
      true
    );
  }

  const url = `${ZEROX_LEVELS_URL}?range_pct=15&buckets=60`;
  const result = await fetchJson<ZeroxEnvelope<ZeroxLevelsData>>(url, { headers, timeoutMs: 12_000 });
  if (!result.ok) {
    return unavailableSeries(
      "hyperliquid",
      "Hyperliquid",
      result.reason,
      result.status === 401 || result.status === 403
    );
  }

  const data = result.data.data;
  if (result.data.success === false || !data?.levels) {
    return unavailableSeries("hyperliquid", "Hyperliquid", result.data.error ?? "0xArchive returned no cluster data", false);
  }

  const midPrice = finiteNumber(data.mid_price);
  const levels = data.levels
    .map((level) => {
      const price = finiteNumber(level.price);
      if (price == null || price <= 0) return null;
      const longNotionalUsd = Math.max(0, finiteNumber(level.long_notional) ?? 0);
      const shortNotionalUsd = Math.max(0, finiteNumber(level.short_notional) ?? 0);
      return {
        price,
        longNotionalUsd,
        shortNotionalUsd,
        notionalUsd: longNotionalUsd + shortNotionalUsd,
        exchangeId: "hyperliquid" as ExchangeId,
        exchangeName: "Hyperliquid",
        source: "Hyperliquid · 0xArchive",
      };
    })
    .filter((level): level is ClusterLevel => level != null)
    .sort((a, b) => a.price - b.price);

  return {
    id: "hyperliquid",
    name: "Hyperliquid",
    status: levels.length ? "ok" : "unavailable",
    reason: levels.length ? null : "0xArchive returned an empty MON snapshot",
    needsApiKey: false,
    source: "Hyperliquid · 0xArchive",
    sideSplit: "source",
    midPrice,
    levels,
  };
}

interface ZeroxVolumeBucket {
  timestamp?: string | number;
  longUsd?: number;
  shortUsd?: number;
  long_usd?: number;
  short_usd?: number;
}

export async function fetchZeroxVolume24h(): Promise<{
  longUsd: number | null;
  shortUsd: number | null;
  reason: string | null;
}> {
  const headers = zeroxHeaders();
  if (!headers) {
    return { longUsd: null, shortUsd: null, reason: "ZEROX_ARCHIVE_API_KEY is not set" };
  }

  const end = Date.now();
  const start = end - 24 * 60 * 60 * 1000;
  const url = `${ZEROX_VOLUME_URL}?interval=1h&start=${start}&end=${end}&limit=24`;
  const result = await fetchJson<ZeroxEnvelope<ZeroxVolumeBucket[]>>(url, { headers, timeoutMs: 12_000 });
  if (!result.ok) {
    return { longUsd: null, shortUsd: null, reason: result.reason };
  }

  const buckets = Array.isArray(result.data.data) ? result.data.data : [];
  if (buckets.length === 0) {
    return { longUsd: null, shortUsd: null, reason: "No 24h Hyperliquid liquidation volume from 0xArchive" };
  }

  let longUsd = 0;
  let shortUsd = 0;
  let sawValue = false;
  for (const bucket of buckets) {
    const long = finiteNumber(bucket.longUsd) ?? finiteNumber(bucket.long_usd);
    const short = finiteNumber(bucket.shortUsd) ?? finiteNumber(bucket.short_usd);
    if (long != null) {
      longUsd += long;
      sawValue = true;
    }
    if (short != null) {
      shortUsd += short;
      sawValue = true;
    }
  }

  if (!sawValue) {
    return { longUsd: null, shortUsd: null, reason: "0xArchive volume buckets had no USD fields" };
  }
  return { longUsd, shortUsd, reason: null };
}

export async function fetchOkxVenue(): Promise<VenueRow> {
  const [markRes, fundRes, oiRes, lsrRes] = await Promise.all([
    fetchJson<{ code?: string; data?: Array<{ markPx?: string }> }>(
      "https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=MON-USDT-SWAP"
    ),
    fetchJson<{ code?: string; data?: Array<{ fundingRate?: string }> }>(
      "https://www.okx.com/api/v5/public/funding-rate?instId=MON-USDT-SWAP"
    ),
    fetchJson<{ code?: string; data?: Array<{ oiUsd?: string }> }>(
      "https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=MON-USDT-SWAP"
    ),
    fetchJson<{ code?: string; data?: Array<[string, string] | { ratio?: string }> }>(
      "https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?instId=MON-USDT-SWAP&period=1H"
    ),
  ]);

  const markUsd = markRes.ok && markRes.data.code === "0" ? finiteNumber(markRes.data.data?.[0]?.markPx) : null;
  const funding = fundRes.ok && fundRes.data.code === "0" ? finiteNumber(fundRes.data.data?.[0]?.fundingRate) : null;
  const oiUsd = oiRes.ok && oiRes.data.code === "0" ? finiteNumber(oiRes.data.data?.[0]?.oiUsd) : null;

  let longShortRatio: number | null = null;
  if (lsrRes.ok && lsrRes.data.code === "0" && Array.isArray(lsrRes.data.data) && lsrRes.data.data.length > 0) {
    const latest = lsrRes.data.data[0];
    longShortRatio = Array.isArray(latest) ? finiteNumber(latest[1]) : finiteNumber(latest.ratio);
  }

  const reasons: string[] = [];
  if (!markRes.ok) reasons.push(`mark: ${markRes.reason}`);
  if (!fundRes.ok) reasons.push(`funding: ${fundRes.reason}`);
  if (!oiRes.ok) reasons.push(`OI: ${oiRes.reason}`);
  if (!lsrRes.ok) reasons.push(`L/S: ${lsrRes.reason}`);

  if (markUsd == null && funding == null && oiUsd == null && longShortRatio == null) {
    return unavailableVenue("okx", "OKX", "cluster", reasons[0] ?? "OKX MON-USDT-SWAP unavailable");
  }

  return {
    id: "okx",
    name: "OKX",
    kind: "cluster",
    status: "ok",
    reason: reasons.length ? reasons.join(" · ") : null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MON-USDT-SWAP · price-level clusters via CoinGlass when the key is set",
  };
}

interface GateContract {
  mark_price?: string;
  funding_rate?: string;
}

interface GateTicker {
  mark_price?: string;
  funding_rate?: string;
}

interface GateStat {
  lsr_account?: number;
  open_interest_usd?: number;
  long_liq_usd?: number;
  short_liq_usd?: number;
  long_liq_usd_new?: number;
  short_liq_usd_new?: number;
}

export async function fetchGateVenue(): Promise<VenueRow> {
  const [contractRes, tickerRes, statsRes] = await Promise.all([
    fetchJson<GateContract>("https://api.gateio.ws/api/v4/futures/usdt/contracts/MON_USDT"),
    fetchJson<GateTicker[]>("https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=MON_USDT"),
    fetchJson<GateStat[]>("https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=MON_USDT&interval=1h&limit=24"),
  ]);

  const contract = contractRes.ok ? contractRes.data : null;
  const ticker = tickerRes.ok && Array.isArray(tickerRes.data) ? tickerRes.data[0] : null;
  const stats = statsRes.ok && Array.isArray(statsRes.data) ? statsRes.data : [];
  const markUsd = finiteNumber(contract?.mark_price) ?? finiteNumber(ticker?.mark_price);
  const funding = finiteNumber(contract?.funding_rate) ?? finiteNumber(ticker?.funding_rate);
  const latestStat = stats.length ? stats[stats.length - 1] : null;
  const oiUsd = finiteNumber(latestStat?.open_interest_usd);

  let liqLong24hUsd: number | null = null;
  let liqShort24hUsd: number | null = null;
  if (stats.length > 0) {
    liqLong24hUsd = 0;
    liqShort24hUsd = 0;
    for (const row of stats) {
      liqLong24hUsd += finiteNumber(row.long_liq_usd_new) ?? finiteNumber(row.long_liq_usd) ?? 0;
      liqShort24hUsd += finiteNumber(row.short_liq_usd_new) ?? finiteNumber(row.short_liq_usd) ?? 0;
    }
  }

  if (markUsd == null && funding == null && oiUsd == null && liqLong24hUsd == null) {
    const reason = !contractRes.ok
      ? contractRes.reason
      : !tickerRes.ok
        ? tickerRes.reason
        : statsRes.ok
          ? "Gate MON_USDT empty"
          : statsRes.reason;
    return unavailableVenue("gate", "Gate", "summary", reason);
  }

  return {
    id: "gate",
    name: "Gate",
    kind: "summary",
    status: "ok",
    reason: null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd,
    liqShort24hUsd,
    longShortRatio: finiteNumber(latestStat?.lsr_account),
    notes: "Extra venue · 24h liquidations from hourly contract stats",
  };
}

export async function fetchBinanceVenue(): Promise<VenueRow> {
  const [premRes, oiRes, lsrRes] = await Promise.all([
    fetchJson<{ markPrice?: string; lastFundingRate?: string; msg?: string }>(
      "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=MONUSDT"
    ),
    fetchJson<{ openInterest?: string }>("https://fapi.binance.com/fapi/v1/openInterest?symbol=MONUSDT"),
    fetchJson<Array<{ longShortRatio?: string }>>(
      "https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=MONUSDT&period=1h&limit=1"
    ),
  ]);

  if (!premRes.ok) {
    return unavailableVenue("binance", "Binance", "cluster", premRes.reason);
  }

  const markUsd = finiteNumber(premRes.data.markPrice);
  const funding = finiteNumber(premRes.data.lastFundingRate);
  const oiBase = oiRes.ok ? finiteNumber(oiRes.data.openInterest) : null;
  const oiUsd = markUsd != null && oiBase != null ? markUsd * oiBase : null;
  const longShortRatio =
    lsrRes.ok && Array.isArray(lsrRes.data) ? finiteNumber(lsrRes.data[0]?.longShortRatio) : null;

  if (markUsd == null && funding == null && oiUsd == null) {
    return unavailableVenue("binance", "Binance", "cluster", premRes.data.msg ?? "Binance MONUSDT unavailable");
  }

  return {
    id: "binance",
    name: "Binance",
    kind: "cluster",
    status: "ok",
    reason: null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MONUSDT · clusters via CoinGlass heatmap when the key is set",
  };
}

interface BybitTicker {
  markPrice?: string;
  fundingRate?: string;
  openInterestValue?: string;
}

export async function fetchBybitVenue(): Promise<VenueRow> {
  const [tickRes, ratioRes] = await Promise.all([
    fetchJson<{ retCode?: number; retMsg?: string; result?: { list?: BybitTicker[] } }>(
      "https://api.bybit.com/v5/market/tickers?category=linear&symbol=MONUSDT"
    ),
    fetchJson<{ result?: { list?: Array<{ buyRatio?: string; sellRatio?: string }> } }>(
      "https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=MONUSDT&period=1h&limit=1"
    ),
  ]);

  if (!tickRes.ok) {
    return unavailableVenue("bybit", "Bybit", "cluster", tickRes.reason);
  }
  if (tickRes.data.retCode != null && tickRes.data.retCode !== 0) {
    return unavailableVenue("bybit", "Bybit", "cluster", tickRes.data.retMsg ?? `Bybit retCode ${tickRes.data.retCode}`);
  }

  const ticker = tickRes.data.result?.list?.[0];
  const markUsd = finiteNumber(ticker?.markPrice);
  const funding = finiteNumber(ticker?.fundingRate);
  const oiUsd = finiteNumber(ticker?.openInterestValue);
  const ratio = ratioRes.ok ? ratioRes.data.result?.list?.[0] : null;
  const buy = finiteNumber(ratio?.buyRatio);
  const sell = finiteNumber(ratio?.sellRatio);
  const longShortRatio = buy != null && sell != null && sell !== 0 ? buy / sell : null;

  if (markUsd == null && funding == null && oiUsd == null) {
    return unavailableVenue("bybit", "Bybit", "cluster", "Bybit MONUSDT ticker empty");
  }

  return {
    id: "bybit",
    name: "Bybit",
    kind: "cluster",
    status: "ok",
    reason: null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MONUSDT · clusters via CoinGlass heatmap when the key is set",
  };
}

export async function fetchBitgetVenue(): Promise<VenueRow> {
  const [tickRes, fundRes, oiRes, lsrRes] = await Promise.all([
    fetchJson<{
      code?: string;
      msg?: string;
      data?: Array<{ markPrice?: string; lastPr?: string; fundingRate?: string; holdingAmount?: string }>;
    }>("https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=MONUSDT"),
    fetchJson<{ code?: string; data?: Array<{ fundingRate?: string }> }>(
      "https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=usdt-futures&symbol=MONUSDT"
    ),
    fetchJson<{ code?: string; data?: { openInterestList?: Array<{ size?: string }> } }>(
      "https://api.bitget.com/api/v2/mix/market/open-interest?productType=USDT-FUTURES&symbol=MONUSDT"
    ),
    fetchJson<{ code?: string; msg?: string; data?: Array<{ longShortRatio?: string }> }>(
      "https://api.bitget.com/api/v2/mix/market/long-short?symbol=MONUSDT&period=1h"
    ),
  ]);

  if (!tickRes.ok) {
    return unavailableVenue("bitget", "Bitget", "cluster", tickRes.reason);
  }
  if (tickRes.data.code !== "00000") {
    return unavailableVenue("bitget", "Bitget", "cluster", tickRes.data.msg ?? "Bitget ticker rejected");
  }

  const ticker = tickRes.data.data?.[0];
  const markUsd = finiteNumber(ticker?.markPrice) ?? finiteNumber(ticker?.lastPr);
  const funding =
    (fundRes.ok && fundRes.data.code === "00000" ? finiteNumber(fundRes.data.data?.[0]?.fundingRate) : null) ??
    finiteNumber(ticker?.fundingRate);
  const oiBase =
    oiRes.ok && oiRes.data.code === "00000"
      ? finiteNumber(oiRes.data.data?.openInterestList?.[0]?.size)
      : finiteNumber(ticker?.holdingAmount);
  const oiUsd = markUsd != null && oiBase != null ? markUsd * oiBase : null;
  const longShortRatio =
    lsrRes.ok && lsrRes.data.code === "00000" ? finiteNumber(lsrRes.data.data?.[0]?.longShortRatio) : null;

  if (markUsd == null && funding == null && oiUsd == null) {
    return unavailableVenue("bitget", "Bitget", "cluster", "Bitget MONUSDT ticker empty");
  }

  return {
    id: "bitget",
    name: "Bitget",
    kind: "cluster",
    status: "ok",
    reason: lsrRes.ok && lsrRes.data.code !== "00000" ? lsrRes.data.msg ?? null : null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MONUSDT · clusters via CoinGlass heatmap when the key is set",
  };
}

interface CoinGlassHeatmap {
  y_axis?: number[];
  liquidation_leverage_data?: Array<[number, number, number] | number[]>;
}

interface CoinGlassEnvelope<T> {
  code?: string;
  msg?: string;
  data?: T;
}

function parseHeatmapLevels(
  data: CoinGlassHeatmap,
  exchange: { id: ClusterSeries["id"]; name: string },
  mark: number | null
): ClusterLevel[] {
  const axis = data.y_axis;
  const points = data.liquidation_leverage_data;
  if (!Array.isArray(axis) || !Array.isArray(points)) return [];

  const byIndex = new Map<number, number>();
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 3) continue;
    const yIndex = finiteNumber(point[1]);
    const usd = finiteNumber(point[2]);
    if (yIndex == null || usd == null) continue;
    byIndex.set(yIndex, (byIndex.get(yIndex) ?? 0) + Math.max(0, usd));
  }

  const levels: ClusterLevel[] = [];
  for (const [index, notionalUsd] of byIndex) {
    const price = finiteNumber(axis[index]);
    if (price == null || price <= 0 || notionalUsd <= 0) continue;
    levels.push({
      price,
      longNotionalUsd: 0,
      shortNotionalUsd: 0,
      notionalUsd,
      exchangeId: exchange.id,
      exchangeName: exchange.name,
      source: `CoinGlass heatmap · ${exchange.name}`,
    });
  }
  return applyMarkImpliedSides(levels, mark).sort((a, b) => a.price - b.price);
}

function parseMapLevels(
  raw: unknown,
  exchange: { id: ClusterSeries["id"]; name: string },
  mark: number | null
): ClusterLevel[] {
  const bag =
    raw && typeof raw === "object" && "data" in raw && (raw as { data?: unknown }).data && typeof (raw as { data?: unknown }).data === "object"
      ? ((raw as { data: Record<string, unknown> }).data as Record<string, unknown>)
      : raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : null;
  if (!bag) return [];

  const levels: ClusterLevel[] = [];
  for (const [key, value] of Object.entries(bag)) {
    const price = finiteNumber(key);
    if (price == null || price <= 0) continue;
    let notionalUsd = 0;
    if (Array.isArray(value)) {
      for (const row of value) {
        if (Array.isArray(row)) {
          notionalUsd += Math.max(0, finiteNumber(row[1]) ?? 0);
        }
      }
    }
    if (notionalUsd <= 0) continue;
    levels.push({
      price,
      longNotionalUsd: 0,
      shortNotionalUsd: 0,
      notionalUsd,
      exchangeId: exchange.id,
      exchangeName: exchange.name,
      source: `CoinGlass map · ${exchange.name}`,
    });
  }
  return applyMarkImpliedSides(levels, mark).sort((a, b) => a.price - b.price);
}

async function fetchCoinglassExchangeSeries(
  headers: Record<string, string>,
  spec: (typeof CLUSTER_EXCHANGES)[number],
  mark: number | null
): Promise<ClusterSeries> {
  let lastReason = "CoinGlass returned no MON heatmap";

  for (const symbol of spec.symbols) {
    const heatmapUrl = `${COINGLASS_BASE}/api/futures/liquidation/heatmap/model2?exchange=${encodeURIComponent(spec.cgName)}&symbol=${encodeURIComponent(symbol)}&range=24h`;
    const heatmap = await fetchJson<CoinGlassEnvelope<CoinGlassHeatmap>>(heatmapUrl, { headers, timeoutMs: 12_000 });
    if (!heatmap.ok) {
      lastReason = heatmap.reason;
      continue;
    }
    if (heatmap.data.code === "0" && heatmap.data.data) {
      const levels = parseHeatmapLevels(heatmap.data.data, spec, mark);
      if (levels.length) {
        return {
          id: spec.id,
          name: spec.name,
          status: "ok",
          reason: null,
          needsApiKey: false,
          source: `CoinGlass heatmap · ${spec.name} ${symbol}`,
          sideSplit: "mark-implied",
          midPrice: mark,
          levels,
        };
      }
      lastReason = `CoinGlass heatmap empty for ${spec.name} ${symbol}`;
    } else {
      lastReason = heatmap.data.msg || heatmap.data.code || lastReason;
    }

    const mapUrl = `${COINGLASS_BASE}/api/futures/liquidation/map?exchange=${encodeURIComponent(spec.cgName)}&symbol=${encodeURIComponent(symbol)}&range=1d`;
    const mapRes = await fetchJson<CoinGlassEnvelope<unknown>>(mapUrl, { headers, timeoutMs: 12_000 });
    if (!mapRes.ok) {
      lastReason = mapRes.reason;
      continue;
    }
    if (mapRes.data.code === "0" && mapRes.data.data) {
      const levels = parseMapLevels(mapRes.data.data, spec, mark);
      if (levels.length) {
        return {
          id: spec.id,
          name: spec.name,
          status: "ok",
          reason: null,
          needsApiKey: false,
          source: `CoinGlass map · ${spec.name} ${symbol}`,
          sideSplit: "mark-implied",
          midPrice: mark,
          levels,
        };
      }
      lastReason = `CoinGlass map empty for ${spec.name} ${symbol}`;
    } else {
      lastReason = mapRes.data.msg || mapRes.data.code || lastReason;
    }
  }

  return unavailableSeries(spec.id, spec.name, lastReason, /api key|401|403|plan/i.test(lastReason));
}

export async function fetchCoinglassClusterSeries(
  marks: Partial<Record<ExchangeId, number | null>>
): Promise<{ series: ClusterSeries[]; aggregator: AggregatorStatus }> {
  const headers = coinglassHeaders();
  if (!headers) {
    return {
      series: CLUSTER_EXCHANGES.map((spec) =>
        unavailableSeries(
          spec.id,
          spec.name,
          "COINGLASS_API_KEY is not set — CoinGlass heatmap is the multi-CEX price-level source",
          true
        )
      ),
      aggregator: {
        id: "coinglass",
        name: "CoinGlass",
        status: "unavailable",
        reason: "COINGLASS_API_KEY is not set",
      },
    };
  }

  const series = await Promise.all(
    CLUSTER_EXCHANGES.map((spec) => fetchCoinglassExchangeSeries(headers, spec, marks[spec.id] ?? null))
  );
  const anyOk = series.some((item) => item.status === "ok");
  return {
    series,
    aggregator: {
      id: "coinglass",
      name: "CoinGlass",
      status: anyOk ? "ok" : "unavailable",
      reason: anyOk ? null : series[0]?.reason ?? "CoinGlass heatmaps unavailable",
    },
  };
}

interface CoinGlassExchangeLiq {
  exchange?: string;
  long_liquidation_usd?: number;
  short_liquidation_usd?: number;
}

const COINGLASS_VENUE_MAP: Record<string, ExchangeId> = {
  hyperliquid: "hyperliquid",
  okx: "okx",
  gate: "gate",
  gateio: "gate",
  binance: "binance",
  bybit: "bybit",
  bitget: "bitget",
};

export async function fetchCoinglassLiquidations(): Promise<{
  aggregator: AggregatorStatus;
  byVenue: Partial<Record<ExchangeId, { longUsd: number; shortUsd: number }>>;
}> {
  const headers = coinglassHeaders();
  if (!headers) {
    return {
      aggregator: {
        id: "coinglass-liq",
        name: "CoinGlass 24h liquidations",
        status: "unavailable",
        reason: "COINGLASS_API_KEY is not set",
      },
      byVenue: {},
    };
  }

  const result = await fetchJson<CoinGlassEnvelope<CoinGlassExchangeLiq[]>>(
    `${COINGLASS_BASE}/api/futures/liquidation/exchange-list?symbol=MON&range=24h`,
    { headers }
  );

  if (!result.ok) {
    return {
      aggregator: { id: "coinglass-liq", name: "CoinGlass 24h liquidations", status: "unavailable", reason: result.reason },
      byVenue: {},
    };
  }
  if (result.data.code !== "0" || !Array.isArray(result.data.data)) {
    return {
      aggregator: {
        id: "coinglass-liq",
        name: "CoinGlass 24h liquidations",
        status: "unavailable",
        reason: result.data.msg || result.data.code || "CoinGlass returned no MON liquidation list",
      },
      byVenue: {},
    };
  }

  const byVenue: Partial<Record<ExchangeId, { longUsd: number; shortUsd: number }>> = {};
  for (const row of result.data.data) {
    const id = COINGLASS_VENUE_MAP[(row.exchange ?? "").toLowerCase().replace(/\s+/g, "")];
    if (!id) continue;
    const longUsd = finiteNumber(row.long_liquidation_usd);
    const shortUsd = finiteNumber(row.short_liquidation_usd);
    if (longUsd == null && shortUsd == null) continue;
    byVenue[id] = { longUsd: longUsd ?? 0, shortUsd: shortUsd ?? 0 };
  }

  return {
    aggregator: { id: "coinglass-liq", name: "CoinGlass 24h liquidations", status: "ok", reason: null },
    byVenue,
  };
}

export async function fetchCoinalyzeStatus(): Promise<AggregatorStatus> {
  const key = process.env.COINALYZE_API_KEY?.trim();
  if (!key) {
    return { id: "coinalyze", name: "Coinalyze", status: "unavailable", reason: "COINALYZE_API_KEY is not set" };
  }

  const result = await fetchJson<unknown>(
    `https://api.coinalyze.net/v1/future-markets?api_key=${encodeURIComponent(key)}`
  );
  if (!result.ok) {
    return { id: "coinalyze", name: "Coinalyze", status: "unavailable", reason: result.reason };
  }
  return { id: "coinalyze", name: "Coinalyze", status: "ok", reason: "Connected · no price-level cluster fields merged" };
}

export function applyExternalLiquidations(
  venues: VenueRow[],
  byVenue: Partial<Record<ExchangeId, { longUsd: number; shortUsd: number }>>
): VenueRow[] {
  return venues.map((venue) => {
    const extra = byVenue[venue.id];
    if (!extra) return venue;
    if (venue.liqLong24hUsd != null || venue.liqShort24hUsd != null) return venue;
    return {
      ...venue,
      liqLong24hUsd: extra.longUsd,
      liqShort24hUsd: extra.shortUsd,
      notes: venue.notes
        ? `${venue.notes} · 24h liquidations from CoinGlass`
        : "24h liquidations from CoinGlass",
    };
  });
}

export function mergeClusterSeries(preferred: ClusterSeries, fallback: ClusterSeries | undefined): ClusterSeries {
  if (preferred.status === "ok" && preferred.levels.length) return preferred;
  if (fallback && fallback.status === "ok" && fallback.levels.length) return fallback;
  if (preferred.status === "ok") return preferred;
  return fallback ?? preferred;
}
