"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ClusterLevel, MonClustersResponse, VenueRow } from "@/lib/mon-clusters/types";

import styles from "./page.module.css";

const POLL_INTERVAL_MS = 90_000;
type SideFilter = "both" | "long" | "short";

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

function densestRows(levels: ClusterLevel[], side: "long" | "short", limit = 8): ClusterLevel[] {
  const key = side === "long" ? "longNotionalUsd" : "shortNotionalUsd";
  return [...levels]
    .filter((level) => level[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, limit);
}

function ClusterChart({
  levels,
  mark,
  side,
}: {
  levels: ClusterLevel[];
  mark: number | null;
  side: SideFilter;
}) {
  const [hover, setHover] = useState<ClusterLevel | null>(null);

  const rows = useMemo(() => {
    return [...levels]
      .filter((level) => {
        if (side === "long") return level.longNotionalUsd > 0;
        if (side === "short") return level.shortNotionalUsd > 0;
        return level.longNotionalUsd > 0 || level.shortNotionalUsd > 0;
      })
      .sort((a, b) => b.price - a.price);
  }, [levels, side]);

  const maxNotional = useMemo(() => {
    let max = 0;
    for (const level of rows) {
      if (side !== "short") max = Math.max(max, level.longNotionalUsd);
      if (side !== "long") max = Math.max(max, level.shortNotionalUsd);
    }
    return max || 1;
  }, [rows, side]);

  if (rows.length === 0) {
    return <p className={styles.empty}>No cluster notional in the current snapshot for this side.</p>;
  }

  const rowH = 14;
  const padTop = 12;
  const padBottom = 18;
  const height = padTop + rows.length * rowH + padBottom;
  const width = 720;
  const dual = side === "both";
  const midX = dual ? 360 : 88;
  const barMax = dual ? 250 : 580;
  const labelX = 8;
  let markY: number | null = null;
  if (mark != null && rows.length > 0) {
    if (mark >= rows[0].price) {
      markY = padTop + 6;
    } else if (mark <= rows[rows.length - 1].price) {
      markY = padTop + (rows.length - 1) * rowH + 6;
    } else {
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
        aria-label="MON long versus short liquidation clusters by price"
      >
        <line
          x1={midX}
          x2={midX}
          y1={padTop - 4}
          y2={height - padBottom + 4}
          className={styles.axis}
        />
        {markY != null && (
          <line x1={0} x2={width} y1={markY} y2={markY} className={styles.markLine} />
        )}
        {rows.map((level, index) => {
          const y = padTop + index * rowH;
          const longW = side === "short" ? 0 : (level.longNotionalUsd / maxNotional) * barMax;
          const shortW = side === "long" ? 0 : (level.shortNotionalUsd / maxNotional) * barMax;
          return (
            <g
              key={`${level.price}-${index}`}
              onMouseEnter={() => setHover(level)}
              onMouseLeave={() => setHover(null)}
            >
              <text x={labelX} y={y + 10} className={styles.priceLabel}>
                {formatPrice(level.price)}
              </text>
              {dual ? (
                <>
                  <rect
                    x={midX - longW}
                    y={y + 2}
                    width={Math.max(longW, 0)}
                    height={10}
                    className={styles.longBar}
                  />
                  <rect
                    x={midX}
                    y={y + 2}
                    width={Math.max(shortW, 0)}
                    height={10}
                    className={styles.shortBar}
                  />
                </>
              ) : (
                <rect
                  x={midX}
                  y={y + 2}
                  width={Math.max(side === "long" ? longW : shortW, 0)}
                  height={10}
                  className={side === "long" ? styles.longBar : styles.shortBar}
                />
              )}
              <text x={width - 8} y={y + 10} className={styles.distLabel} textAnchor="end">
                {formatPct(distancePct(level.price, mark))}
              </text>
            </g>
          );
        })}
      </svg>
      <div className={styles.chartHint} aria-live="polite">
        {hover ? (
          <>
            {formatPrice(hover.price)} · longs {formatUsd(hover.longNotionalUsd)} · shorts{" "}
            {formatUsd(hover.shortNotionalUsd)} · {formatPct(distancePct(hover.price, mark))} from mark
          </>
        ) : (
          "Hover a bucket for notional and distance from mark"
        )}
      </div>
    </div>
  );
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
                  {row.name}
                  {row.kind === "cluster" ? <span className={styles.badge}>Clusters</span> : null}
                </span>
                <span className={styles.venueMeta}>
                  {row.status === "unavailable"
                    ? row.reason ?? "Unavailable"
                    : row.notes ?? "Summary"}
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
  const dataRef = useRef<MonClustersResponse | null>(null);
  dataRef.current = data;

  const load = useCallback(async (forceRefresh = false) => {
    setRefreshing(Boolean(dataRef.current) || forceRefresh);
    try {
      const next = await fetchClusters(forceRefresh);
      setData(next);
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
    data?.prices.hyperliquidMark.usd ??
    data?.clusters.midPrice ??
    data?.prices.coinbaseSpot.usd ??
    null;
  const spot = data?.prices.coinbaseSpot.usd ?? null;
  const basisPct = spot != null && mark != null && mark !== 0 ? ((spot - mark) / mark) * 100 : null;

  const longRows = data ? densestRows(data.clusters.levels, "long") : [];
  const shortRows = data ? densestRows(data.clusters.levels, "short") : [];

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
            Where longs and shorts are clustered on Hyperliquid, with a public-API summary of other
            perp venues. Data only — no trade advice.
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
          <strong className={styles.statValue}>
            {loading && !data ? "…" : formatPrice(spot)}
          </strong>
          <span className={styles.statMeta}>
            {data?.prices.coinbaseSpot.status === "unavailable"
              ? data.prices.coinbaseSpot.reason ?? "Unavailable"
              : "MON-USD"}
          </span>
        </article>
        <article className={styles.priceCard}>
          <span className={styles.statLabel}>Hyperliquid mark</span>
          <strong className={styles.statValue}>
            {loading && !data ? "…" : formatPrice(data?.prices.hyperliquidMark.usd ?? null)}
          </strong>
          <span className={styles.statMeta}>
            {data?.prices.hyperliquidMark.status === "unavailable"
              ? data.prices.hyperliquidMark.reason ?? "Unavailable"
              : "MON perp"}
          </span>
        </article>
        <article className={styles.priceCard}>
          <span className={styles.statLabel}>Spot vs mark</span>
          <strong className={styles.statValue}>{formatPct(basisPct)}</strong>
          <span className={styles.statMeta}>Distance of Coinbase spot from HL mark</span>
        </article>
      </section>

      <section className={styles.section} aria-label="Price-level clusters">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Hyperliquid long / short clusters</h2>
            <p className={styles.sectionSub}>
              Projected forced-liquidation exposure by price bucket (0xArchive). Mark line + % from
              mark. Not completed liquidations.
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

        {loading && !data ? (
          <div className={`${styles.chartSkeleton} ${styles.skeleton}`} />
        ) : data?.clusters.status === "unavailable" ? (
          <div className={styles.prompt} role="status">
            <p>
              {data.clusters.needsApiKey
                ? "Price-level heatmap needs ZEROX_ARCHIVE_API_KEY on the server. Public spot, mark, funding, and venue rows still load without it."
                : data.clusters.reason ?? "Cluster snapshot unavailable."}
            </p>
          </div>
        ) : data && data.clusters.levels.length === 0 ? (
          <p className={styles.empty}>
            {data.clusters.reason ?? "0xArchive returned no MON buckets for this snapshot."}
          </p>
        ) : (
          data && (
            <>
              <div className={styles.clusterMeta}>
                <span>Snapshot mid {formatPrice(data.clusters.midPrice)}</span>
                <span>Longs at risk {formatUsd(data.clusters.totalLongUsd)}</span>
                <span>Shorts at risk {formatUsd(data.clusters.totalShortUsd)}</span>
                {data.clusters.snapshotTs ? <span>Snapshot {data.clusters.snapshotTs}</span> : null}
              </div>
              <ClusterChart levels={data.clusters.levels} mark={mark} side={side} />
            </>
          )
        )}
      </section>

      <section className={styles.section} aria-label="Densest buckets">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Densest buckets</h2>
            <p className={styles.sectionSub}>Highest notional long and short price buckets from the cluster snapshot.</p>
          </div>
        </div>
        {data?.clusters.status === "ok" && (longRows.length > 0 || shortRows.length > 0) ? (
          <div className={styles.splitTables}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Long price</th>
                    <th scope="col">Notional</th>
                    <th scope="col">From mark</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {longRows.map((row) => (
                    <tr key={`long-${row.price}`}>
                      <th scope="row">{formatPrice(row.price)}</th>
                      <td className={styles.longCell}>{formatUsd(row.longNotionalUsd)}</td>
                      <td>{formatPct(distancePct(row.price, mark))}</td>
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
                    <th scope="col">From mark</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {shortRows.map((row) => (
                    <tr key={`short-${row.price}`}>
                      <th scope="row">{formatPrice(row.price)}</th>
                      <td className={styles.shortCell}>{formatUsd(row.shortNotionalUsd)}</td>
                      <td>{formatPct(distancePct(row.price, mark))}</td>
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
              ? "Bucket table appears after ZEROX_ARCHIVE_API_KEY is set."
              : "No dense buckets to list."}
          </p>
        )}
      </section>

      <section className={styles.section} aria-label="Venue summary">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Venue summary</h2>
            <p className={styles.sectionSub}>
              Public mark, funding, open interest, 24h completed liquidations, and account long/short
              ratio when the venue publishes them. Em dashes are missing data, not zeros.
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
          Cluster chart: Hyperliquid projected levels via 0xArchive. Other venues are summary-only
          (Binance/Bybit/OKX heatmaps are typically locked). Aggregators:{" "}
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
