"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ClusterLevel,
  ClusterSeries,
  ExchangeId,
  MonClustersResponse,
  VenueRow,
} from "@/lib/mon-clusters/types";

import styles from "./page.module.css";

const POLL_INTERVAL_MS = 90_000;
const EXCHANGE_ORDER: ExchangeId[] = ["binance", "bybit", "okx", "bitget", "hyperliquid"];
type SideFilter = "both" | "long" | "short";

const EXCHANGE_COLORS: Record<string, string> = {
  binance: "#f6c343",
  bybit: "#f59e71",
  okx: "#7dd3fc",
  bitget: "#34d399",
  hyperliquid: "#c4b5fd",
};

async function fetchClusters(forceRefresh = false): Promise<MonClustersResponse> {
  const params = forceRefresh ? "?refresh=1" : "";
  const resp = await fetch(`/api/mon-clusters${params}`, { cache: "no-store" });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `MON clusters API error ${resp.status}`);
  }
  return resp.json() as Promise<MonClustersResponse>;
}

function formatUsd(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(digits)}`;
}

function formatPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.1) return value.toFixed(5);
  return value.toFixed(6);
}

function formatFunding(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(4)}%`;
}

function formatRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatClock(iso: string, timeZone: string, suffix: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${text} ${suffix}`;
}

function distancePct(price: number, mark: number | null): number | null {
  if (mark == null || mark === 0) return null;
  return ((price - mark) / mark) * 100;
}

function defaultEnabled(series: ClusterSeries[]): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const id of EXCHANGE_ORDER) next[id] = true;
  for (const item of series) next[item.id] = true;
  return next;
}

interface Bucket {
  price: number;
  byExchange: Record<string, { long: number; short: number; total: number; source: string; name: string }>;
}

function buildBuckets(series: ClusterSeries[], enabled: Record<string, boolean>, bucketCount = 48): Bucket[] {
  const levels: ClusterLevel[] = [];
  for (const item of series) {
    if (!enabled[item.id] || item.status !== "ok") continue;
    levels.push(...item.levels);
  }
  if (!levels.length) return [];

  const min = Math.min(...levels.map((level) => level.price));
  const max = Math.max(...levels.map((level) => level.price));
  const span = max - min || min * 0.002 || 0.0001;
  const width = span / bucketCount;
  const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    price: min + (index + 0.5) * width,
    byExchange: {},
  }));

  for (const level of levels) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((level.price - min) / width)));
    const bucket = buckets[index];
    const current = bucket.byExchange[level.exchangeId] ?? {
      long: 0,
      short: 0,
      total: 0,
      source: level.source,
      name: level.exchangeName,
    };
    current.long += level.longNotionalUsd;
    current.short += level.shortNotionalUsd;
    current.total += level.notionalUsd;
    bucket.byExchange[level.exchangeId] = current;
  }

  return buckets.filter((bucket) => Object.values(bucket.byExchange).some((row) => row.total > 0 || row.long > 0 || row.short > 0));
}

function ClusterChart({
  buckets,
  mark,
  side,
  enabledIds,
}: {
  buckets: Bucket[];
  mark: number | null;
  side: SideFilter;
  enabledIds: ExchangeId[];
}) {
  const [hover, setHover] = useState<Bucket | null>(null);
  const rows = useMemo(() => {
    return [...buckets]
      .filter((bucket) => {
        const values = Object.values(bucket.byExchange);
        if (side === "long") return values.some((row) => row.long > 0);
        if (side === "short") return values.some((row) => row.short > 0);
        return values.some((row) => row.long > 0 || row.short > 0 || row.total > 0);
      })
      .sort((a, b) => b.price - a.price);
  }, [buckets, side]);

  const maxNotional = useMemo(() => {
    let max = 0;
    for (const bucket of rows) {
      let long = 0;
      let short = 0;
      let total = 0;
      for (const row of Object.values(bucket.byExchange)) {
        long += row.long;
        short += row.short;
        total += row.total;
      }
      if (side === "long") max = Math.max(max, long);
      else if (side === "short") max = Math.max(max, short);
      else max = Math.max(max, long, short, total);
    }
    return max || 1;
  }, [rows, side]);

  if (rows.length === 0) {
    return <p className={styles.empty}>No cluster notional for the selected exchanges and side.</p>;
  }

  const rowH = 15;
  const padTop = 12;
  const padBottom = 18;
  const height = padTop + rows.length * rowH + padBottom;
  const width = 760;
  const dual = side === "both";
  const midX = dual ? 380 : 96;
  const barMax = dual ? 250 : 590;
  let markY: number | null = null;
  if (mark != null && rows.length > 0) {
    if (mark >= rows[0].price) markY = padTop + 6;
    else if (mark <= rows[rows.length - 1].price) markY = padTop + (rows.length - 1) * rowH + 6;
    else {
      for (let i = 0; i < rows.length - 1; i++) {
        const hi = rows[i].price;
        const lo = rows[i + 1].price;
        if (mark <= hi && mark >= lo) {
          const t = hi === lo ? 0 : (hi - mark) / (hi - lo);
          markY = padTop + i * rowH + t * rowH + 6;
          break;
        }
      }
    }
  }

  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Cross-exchange MON liquidation clusters by price"
      >
        <line x1={midX} x2={midX} y1={padTop - 4} y2={height - padBottom + 4} className={styles.axis} />
        {markY != null && <line x1={0} x2={width} y1={markY} y2={markY} className={styles.markLine} />}
        {rows.map((bucket, index) => {
          const y = padTop + index * rowH;
          const stack = enabledIds
            .map((id) => ({ id, row: bucket.byExchange[id] }))
            .filter((item) => item.row);
          let longOffset = 0;
          let shortOffset = 0;
          return (
            <g
              key={`${bucket.price}-${index}`}
              onMouseEnter={() => setHover(bucket)}
              onMouseLeave={() => setHover(null)}
            >
              <text x={8} y={y + 10} className={styles.priceLabel}>
                {formatPrice(bucket.price)}
              </text>
              {stack.map(({ id, row }) => {
                if (!row) return null;
                const longVal = side === "short" ? 0 : row.long || (side === "both" ? 0 : 0);
                const shortVal = side === "long" ? 0 : row.short || (side === "both" ? 0 : 0);
                const density = side === "both" && row.long === 0 && row.short === 0 ? row.total : 0;
                const longW = ((longVal + (side === "long" ? density : 0)) / maxNotional) * barMax;
                const shortW = ((shortVal + (side !== "long" ? density : 0)) / maxNotional) * barMax;
                const color = EXCHANGE_COLORS[id] ?? "#a7f3d0";
                const nodes = [];
                if (dual) {
                  if (longW > 0) {
                    nodes.push(
                      <rect
                        key={`${id}-l`}
                        x={midX - longOffset - longW}
                        y={y + 2}
                        width={longW}
                        height={10}
                        fill={color}
                        opacity={0.88}
                      />
                    );
                    longOffset += longW;
                  }
                  if (shortW > 0) {
                    nodes.push(
                      <rect
                        key={`${id}-s`}
                        x={midX + shortOffset}
                        y={y + 2}
                        width={shortW}
                        height={10}
                        fill={color}
                        opacity={0.88}
                      />
                    );
                    shortOffset += shortW;
                  }
                } else {
                  const w = side === "long" ? longW : shortW;
                  if (w > 0) {
                    nodes.push(
                      <rect
                        key={`${id}-o`}
                        x={midX + (side === "long" ? longOffset : shortOffset)}
                        y={y + 2}
                        width={w}
                        height={10}
                        fill={color}
                        opacity={0.88}
                      />
                    );
                    if (side === "long") longOffset += w;
                    else shortOffset += w;
                  }
                }
                return nodes;
              })}
              <text x={width - 8} y={y + 10} className={styles.distLabel} textAnchor="end">
                {formatPct(distancePct(bucket.price, mark))}
              </text>
            </g>
          );
        })}
      </svg>
      <div className={styles.chartHint} aria-live="polite">
        {hover ? (
          <>
            {formatPrice(hover.price)}
            {enabledIds.map((id) => {
              const row = hover.byExchange[id];
              if (!row) return null;
              return (
                <span key={id}>
                  {" "}
                  · {row.name} L {formatUsd(row.long)} / S {formatUsd(row.short)}
                </span>
              );
            })}{" "}
            · {formatPct(distancePct(hover.price, mark))} from mark
          </>
        ) : (
          "Hover a bucket · stacked colors are per exchange · % is distance from mark"
        )}
      </div>
    </div>
  );
}

function densestRows(buckets: Bucket[], side: "long" | "short", limit = 8): Array<{
  price: number;
  notional: number;
  exchange: string;
  source: string;
}> {
  const rows: Array<{ price: number; notional: number; exchange: string; source: string }> = [];
  for (const bucket of buckets) {
    for (const row of Object.values(bucket.byExchange)) {
      const notional = side === "long" ? row.long : row.short;
      if (notional > 0) {
        rows.push({ price: bucket.price, notional, exchange: row.name, source: row.source });
      }
    }
  }
  return rows.sort((a, b) => b.notional - a.notional).slice(0, limit);
}

function VenueTable({ rows }: { rows: VenueRow[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Mark</th>
            <th scope="col">Funding</th>
            <th scope="col">OI</th>
            <th scope="col">24h long liq</th>
            <th scope="col">24h short liq</th>
            <th scope="col">Account L/S</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.kind === "cluster" ? styles.highlightRow : undefined}>
              <th scope="row">
                <span className={styles.venueName}>
                  <span className={styles.swatch} style={{ background: EXCHANGE_COLORS[row.id] ?? "#64748b" }} />
                  {row.name}
                </span>
                <span className={styles.venueMeta}>
                  {row.status === "unavailable" ? row.reason ?? "Unavailable" : row.notes ?? "Summary"}
                </span>
              </th>
              {row.status === "unavailable" ? (
                <td colSpan={6} className={styles.cellUnavailable}>
                  Unavailable{row.reason ? ` — ${row.reason}` : ""}
                </td>
              ) : (
                <>
                  <td>{formatPrice(row.markUsd)}</td>
                  <td>{formatFunding(row.funding)}</td>
                  <td>{formatUsd(row.oiUsd)}</td>
                  <td className={styles.longCell}>{formatUsd(row.liqLong24hUsd)}</td>
                  <td className={styles.shortCell}>{formatUsd(row.liqShort24hUsd)}</td>
                  <td>{formatRatio(row.longShortRatio)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MonClustersPage() {
  const [data, setData] = useState<MonClustersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<SideFilter>("both");
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    binance: true,
    bybit: true,
    okx: true,
    bitget: true,
    hyperliquid: true,
  });
  const dataRef = useRef<MonClustersResponse | null>(null);
  dataRef.current = data;

  const load = useCallback(async (forceRefresh = false) => {
    setRefreshing(Boolean(dataRef.current) || forceRefresh);
    try {
      const next = await fetchClusters(forceRefresh);
      setData(next);
      setEnabled((prev) => ({ ...defaultEnabled(next.clusters.series), ...prev }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MON clusters");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => void load(false), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const mark =
    data?.venues.find((row) => row.id === "binance")?.markUsd ??
    data?.venues.find((row) => row.id === "okx")?.markUsd ??
    data?.prices.hyperliquidMark.usd ??
    data?.prices.coinbaseSpot.usd ??
    null;
  const spot = data?.prices.coinbaseSpot.usd ?? null;
  const basisPct = spot != null && mark != null && mark !== 0 ? ((spot - mark) / mark) * 100 : null;
  const enabledIds = EXCHANGE_ORDER.filter((id) => enabled[id]);
  const buckets = useMemo(
    () => (data ? buildBuckets(data.clusters.series, enabled) : []),
    [data, enabled]
  );
  const longRows = densestRows(buckets, "long");
  const shortRows = densestRows(buckets, "short");
  const readySeries = data?.clusters.series.filter((item) => item.status === "ok" && item.levels.length) ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow} aria-hidden="true" />
      <div className={styles.bgGrid} aria-hidden="true" />

      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <div className={styles.navRow}>
            <Link href="/" className={styles.backLink}>
              ← Dashboard
            </Link>
            <Link href="/compare" className={styles.backLink}>
              USDC compare
            </Link>
          </div>
          <h1 className={styles.title}>MON liquidation clusters</h1>
          <p className={styles.lede}>
            Cross-exchange map of where MON longs and shorts are clustered — Binance, Bybit, OKX,
            Bitget, plus Hyperliquid. Data only.
          </p>
        </div>
        <div className={styles.topRight}>
          <p className={styles.updated}>
            {data ? (
              <>
                {refreshing ? "Updating… · " : ""}
                {formatClock(data.fetchedAt, "Asia/Kolkata", "IST")}
                <span className={styles.updatedSep}>·</span>
                {formatClock(data.fetchedAt, "UTC", "UTC")}
              </>
            ) : (
              "Auto-refresh ~90s"
            )}
          </p>
          <button
            type="button"
            className={styles.reloadButton}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div className={styles.error} role="alert">
          {error}
          {data ? " — showing last successful payload" : ""}
        </div>
      )}

      <section className={styles.priceStrip} aria-label="MON prices">
        <article className={styles.priceCard}>
          <span className={styles.statLabel}>Coinbase spot</span>
          <strong className={styles.statValue}>{loading && !data ? "…" : formatPrice(spot)}</strong>
          <span className={styles.statMeta}>
            {data?.prices.coinbaseSpot.status === "unavailable"
              ? data.prices.coinbaseSpot.reason ?? "Unavailable"
              : "MON-USD"}
          </span>
        </article>
        <article className={styles.priceCard}>
          <span className={styles.statLabel}>Reference mark</span>
          <strong className={styles.statValue}>{loading && !data ? "…" : formatPrice(mark)}</strong>
          <span className={styles.statMeta}>First available CEX / HL mark</span>
        </article>
        <article className={styles.priceCard}>
          <span className={styles.statLabel}>Spot vs mark</span>
          <strong className={styles.statValue}>{formatPct(basisPct)}</strong>
          <span className={styles.statMeta}>Coinbase spot versus reference mark</span>
        </article>
      </section>

      <section className={styles.section} aria-label="Price-level clusters">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Cross-exchange cluster map</h2>
            <p className={styles.sectionSub}>
              Overlay of price-level liquidation density. Toggle venues. Combined view is the sum of
              enabled series. CoinGlass sides are mark-implied unless a source publishes L/S.
            </p>
          </div>
          <div className={styles.tabs} role="tablist" aria-label="Cluster side">
            {(
              [
                ["both", "Both"],
                ["long", "Longs"],
                ["short", "Shorts"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={side === value}
                className={`${styles.tab} ${side === value ? styles.tabActive : ""}`}
                onClick={() => setSide(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.exchangeToggles} role="group" aria-label="Exchanges">
          {EXCHANGE_ORDER.map((id) => {
            const series = data?.clusters.series.find((item) => item.id === id);
            const ready = series?.status === "ok" && (series.levels.length ?? 0) > 0;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={enabled[id]}
                className={`${styles.exchangeToggle} ${enabled[id] ? styles.exchangeOn : ""}`}
                onClick={() => setEnabled((prev) => ({ ...prev, [id]: !prev[id] }))}
              >
                <span className={styles.swatch} style={{ background: EXCHANGE_COLORS[id] }} />
                {series?.name ?? id}
                <span className={styles.toggleMeta}>{ready ? "series" : series?.needsApiKey ? "needs key" : "no series"}</span>
              </button>
            );
          })}
        </div>

        {loading && !data ? (
          <div className={`${styles.chartSkeleton} ${styles.skeleton}`} />
        ) : readySeries.length === 0 ? (
          <div className={styles.prompt} role="status">
            <p>{data?.clusters.note}</p>
          </div>
        ) : (
          <>
            <div className={styles.clusterMeta}>
              {data?.clusters.series.map((item) =>
                enabled[item.id] ? (
                  <span key={item.id}>
                    {item.name}: {item.status === "ok" ? `${item.levels.length} buckets` : item.reason ?? "unavailable"}
                  </span>
                ) : null
              )}
            </div>
            <ClusterChart buckets={buckets} mark={mark} side={side} enabledIds={enabledIds} />
          </>
        )}
      </section>

      <section className={styles.section} aria-label="Densest buckets">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Densest buckets</h2>
            <p className={styles.sectionSub}>Highest notional long and short buckets among enabled exchanges.</p>
          </div>
        </div>
        {longRows.length || shortRows.length ? (
          <div className={styles.splitTables}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Long price</th>
                    <th scope="col">Notional</th>
                    <th scope="col">Exchange</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {longRows.map((row, index) => (
                    <tr key={`long-${row.price}-${row.exchange}-${index}`}>
                      <th scope="row">{formatPrice(row.price)}</th>
                      <td className={styles.longCell}>{formatUsd(row.notional)}</td>
                      <td>{row.exchange}</td>
                      <td>{row.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Short price</th>
                    <th scope="col">Notional</th>
                    <th scope="col">Exchange</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {shortRows.map((row, index) => (
                    <tr key={`short-${row.price}-${row.exchange}-${index}`}>
                      <th scope="row">{formatPrice(row.price)}</th>
                      <td className={styles.shortCell}>{formatUsd(row.notional)}</td>
                      <td>{row.exchange}</td>
                      <td>{row.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className={styles.empty}>
            {data?.clusters.needsApiKey
              ? "Bucket table fills after CoinGlass (and optional 0xArchive) keys return series."
              : "No dense buckets for the current exchange filters."}
          </p>
        )}
      </section>

      <section className={styles.section} aria-label="Venue summary">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Venue detail</h2>
            <p className={styles.sectionSub}>
              Mark, funding, open interest, 24h completed liquidations, and account L/S when published.
              Em dashes are missing data, not zeros.
            </p>
          </div>
        </div>
        {loading && !data ? (
          <div className={`${styles.tableSkeleton} ${styles.skeleton}`} />
        ) : data ? (
          <VenueTable rows={data.venues} />
        ) : null}
      </section>

      {data && (
        <p className={styles.footnote}>
          {data.clusters.note} Aggregators:{" "}
          {data.aggregators.map((item, index) => (
            <span key={item.id}>
              {index > 0 ? " · " : ""}
              {item.name} {item.status === "ok" ? "ok" : `unavailable (${item.reason})`}
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}
