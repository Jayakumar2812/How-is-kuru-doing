import "server-only";

import { fetchJson, finiteNumber, sleep, type HttpResult } from "@/lib/mon-clusters/http";
import type {
  AggregatorStatus,
  ClusterLevel,
  ClusterPayload,
  PriceQuote,
  VenueRow,
} from "@/lib/mon-clusters/types";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const ZEROX_LEVELS_URL = "https://api.0xarchive.io/v1/hyperliquid/liquidations/MON/levels";
const ZEROX_VOLUME_URL = "https://api.0xarchive.io/v1/hyperliquid/liquidations/MON/volume";
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/MON-USD/spot";
const CLUSTER_SOURCE = "Hyperliquid · 0xArchive";

function unavailableVenue(id: string, name: string, kind: VenueRow["kind"], reason: string): VenueRow {
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

function zeroxHeaders(): Record<string, string> | null {
  const key = process.env.ZEROX_ARCHIVE_API_KEY?.trim();
  if (!key) return null;
  return { "X-API-Key": key };
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

function parseClusterLevels(raw: ZeroxLevel[] | undefined): ClusterLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((level) => {
      const price = finiteNumber(level.price);
      if (price == null || price <= 0) return null;
      return {
        price,
        longNotionalUsd: Math.max(0, finiteNumber(level.long_notional) ?? 0),
        shortNotionalUsd: Math.max(0, finiteNumber(level.short_notional) ?? 0),
        longCount: finiteNumber(level.long_count),
        shortCount: finiteNumber(level.short_count),
        source: CLUSTER_SOURCE,
      };
    })
    .filter((level): level is ClusterLevel => level != null)
    .sort((a, b) => a.price - b.price);
}

export async function fetchZeroxClusters(): Promise<ClusterPayload> {
  const headers = zeroxHeaders();
  if (!headers) {
    return {
      status: "unavailable",
      reason: "Set ZEROX_ARCHIVE_API_KEY on the server to load Hyperliquid price-level clusters.",
      needsApiKey: true,
      midPrice: null,
      snapshotTs: null,
      totalLongUsd: null,
      totalShortUsd: null,
      levels: [],
    };
  }

  const url = `${ZEROX_LEVELS_URL}?range_pct=15&buckets=60`;
  const result = await fetchJson<ZeroxEnvelope<ZeroxLevelsData>>(url, { headers, timeoutMs: 12_000 });
  if (!result.ok) {
    return {
      status: "unavailable",
      reason: result.reason,
      needsApiKey: result.status === 401 || result.status === 403,
      midPrice: null,
      snapshotTs: null,
      totalLongUsd: null,
      totalShortUsd: null,
      levels: [],
    };
  }

  const payload = result.data;
  const data = payload.data;
  if (payload.success === false || !data) {
    return {
      status: "unavailable",
      reason: payload.error ?? "0xArchive returned no cluster data",
      needsApiKey: false,
      midPrice: null,
      snapshotTs: null,
      totalLongUsd: null,
      totalShortUsd: null,
      levels: [],
    };
  }

  const levels = parseClusterLevels(data.levels);
  return {
    status: "ok",
    reason: levels.length === 0 ? "0xArchive returned an empty snapshot for MON" : null,
    needsApiKey: false,
    midPrice: finiteNumber(data.mid_price),
    snapshotTs: typeof data.snapshot_ts === "string" ? data.snapshot_ts : null,
    totalLongUsd: finiteNumber(data.total_long),
    totalShortUsd: finiteNumber(data.total_short),
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
    fetchJson<{ code?: string; data?: Array<{ oiUsd?: string; oiCcy?: string }> }>(
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
    if (Array.isArray(latest)) {
      longShortRatio = finiteNumber(latest[1]);
    } else {
      longShortRatio = finiteNumber(latest.ratio);
    }
  }

  const reasons: string[] = [];
  if (!markRes.ok) reasons.push(`mark: ${markRes.reason}`);
  if (!fundRes.ok) reasons.push(`funding: ${fundRes.reason}`);
  if (!oiRes.ok) reasons.push(`OI: ${oiRes.reason}`);
  if (!lsrRes.ok) reasons.push(`L/S: ${lsrRes.reason}`);

  if (markUsd == null && funding == null && oiUsd == null && longShortRatio == null) {
    return unavailableVenue("okx", "OKX", "summary", reasons[0] ?? "OKX MON-USDT-SWAP unavailable");
  }

  return {
    id: "okx",
    name: "OKX",
    kind: "summary",
    status: "ok",
    reason: reasons.length ? reasons.join(" · ") : null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MON-USDT-SWAP · 24h liquidation totals are not on the public REST snapshot",
  };
}

interface GateContract {
  mark_price?: string;
  funding_rate?: string;
  last_price?: string;
  quanto_multiplier?: string;
}

interface GateTicker {
  mark_price?: string;
  funding_rate?: string;
  total_size?: string;
  quanto_multiplier?: string;
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

  const longShortRatio = finiteNumber(latestStat?.lsr_account);

  if (markUsd == null && funding == null && oiUsd == null && liqLong24hUsd == null) {
    const reason = !contractRes.ok ? contractRes.reason : !tickerRes.ok ? tickerRes.reason : statsRes.ok ? "Gate MON_USDT empty" : statsRes.reason;
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
    longShortRatio,
    notes: "MON_USDT · 24h liquidations summed from hourly contract stats",
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
    return unavailableVenue("binance", "Binance", "summary", premRes.reason);
  }

  const markUsd = finiteNumber(premRes.data.markPrice);
  const funding = finiteNumber(premRes.data.lastFundingRate);
  const oiBase = oiRes.ok ? finiteNumber(oiRes.data.openInterest) : null;
  const oiUsd = markUsd != null && oiBase != null ? markUsd * oiBase : null;
  const longShortRatio =
    lsrRes.ok && Array.isArray(lsrRes.data) ? finiteNumber(lsrRes.data[0]?.longShortRatio) : null;

  if (markUsd == null && funding == null && oiUsd == null) {
    return unavailableVenue("binance", "Binance", "summary", premRes.data.msg ?? "Binance MONUSDT unavailable");
  }

  return {
    id: "binance",
    name: "Binance",
    kind: "summary",
    status: "ok",
    reason: null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MONUSDT · price-level heatmap not on the public API",
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
    return unavailableVenue("bybit", "Bybit", "summary", tickRes.reason);
  }
  if (tickRes.data.retCode != null && tickRes.data.retCode !== 0) {
    return unavailableVenue("bybit", "Bybit", "summary", tickRes.data.retMsg ?? `Bybit retCode ${tickRes.data.retCode}`);
  }

  const ticker = tickRes.data.result?.list?.[0];
  const markUsd = finiteNumber(ticker?.markPrice);
  const funding = finiteNumber(ticker?.fundingRate);
  const oiUsd = finiteNumber(ticker?.openInterestValue);

  let longShortRatio: number | null = null;
  const ratio = ratioRes.ok ? ratioRes.data.result?.list?.[0] : null;
  const buy = finiteNumber(ratio?.buyRatio);
  const sell = finiteNumber(ratio?.sellRatio);
  if (buy != null && sell != null && sell !== 0) {
    longShortRatio = buy / sell;
  }

  if (markUsd == null && funding == null && oiUsd == null) {
    return unavailableVenue("bybit", "Bybit", "summary", "Bybit MONUSDT ticker empty");
  }

  return {
    id: "bybit",
    name: "Bybit",
    kind: "summary",
    status: "ok",
    reason: null,
    markUsd,
    funding,
    oiUsd,
    liqLong24hUsd: null,
    liqShort24hUsd: null,
    longShortRatio,
    notes: "MONUSDT · price-level heatmap not on the public API",
  };
}

interface CoinGlassExchangeLiq {
  exchange?: string;
  long_liquidation_usd?: number;
  short_liquidation_usd?: number;
}

const COINGLASS_VENUE_MAP: Record<string, string> = {
  hyperliquid: "hyperliquid",
  okx: "okx",
  gate: "gate",
  gateio: "gate",
  binance: "binance",
  bybit: "bybit",
};

export async function fetchCoinglassLiquidations(): Promise<{
  aggregator: AggregatorStatus;
  byVenue: Record<string, { longUsd: number; shortUsd: number }>;
}> {
  const key = process.env.COINGLASS_API_KEY?.trim();
  if (!key) {
    return {
      aggregator: {
        id: "coinglass",
        name: "CoinGlass",
        status: "unavailable",
        reason: "COINGLASS_API_KEY is not set · 24h venue liquidations stay blank unless a venue publishes them",
      },
      byVenue: {},
    };
  }

  const result = await fetchJson<{
    code?: string;
    msg?: string;
    data?: CoinGlassExchangeLiq[];
  }>("https://open-api-v4.coinglass.com/api/futures/liquidation/exchange-list?symbol=MON&range=24h", {
    headers: { "CG-API-KEY": key },
  });

  if (!result.ok) {
    return {
      aggregator: { id: "coinglass", name: "CoinGlass", status: "unavailable", reason: result.reason },
      byVenue: {},
    };
  }
  if (result.data.code !== "0" || !Array.isArray(result.data.data)) {
    return {
      aggregator: {
        id: "coinglass",
        name: "CoinGlass",
        status: "unavailable",
        reason: result.data.msg || result.data.code || "CoinGlass returned no MON liquidation list",
      },
      byVenue: {},
    };
  }

  const byVenue: Record<string, { longUsd: number; shortUsd: number }> = {};
  for (const row of result.data.data) {
    const id = COINGLASS_VENUE_MAP[(row.exchange ?? "").toLowerCase().replace(/\s+/g, "")];
    if (!id) continue;
    const longUsd = finiteNumber(row.long_liquidation_usd);
    const shortUsd = finiteNumber(row.short_liquidation_usd);
    if (longUsd == null && shortUsd == null) continue;
    byVenue[id] = { longUsd: longUsd ?? 0, shortUsd: shortUsd ?? 0 };
  }

  return {
    aggregator: { id: "coinglass", name: "CoinGlass", status: "ok", reason: null },
    byVenue,
  };
}

export async function fetchCoinalyzeStatus(): Promise<AggregatorStatus> {
  const key = process.env.COINALYZE_API_KEY?.trim();
  if (!key) {
    return {
      id: "coinalyze",
      name: "Coinalyze",
      status: "unavailable",
      reason: "COINALYZE_API_KEY is not set",
    };
  }

  const result = await fetchJson<unknown>(
    `https://api.coinalyze.net/v1/future-markets?api_key=${encodeURIComponent(key)}`
  );
  if (!result.ok) {
    return { id: "coinalyze", name: "Coinalyze", status: "unavailable", reason: result.reason };
  }
  return { id: "coinalyze", name: "Coinalyze", status: "ok", reason: "Connected · no MON summary fields merged" };
}

export function applyExternalLiquidations(
  venues: VenueRow[],
  byVenue: Record<string, { longUsd: number; shortUsd: number }>
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
