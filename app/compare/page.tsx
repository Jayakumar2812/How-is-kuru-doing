"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CompareQuotesResponse, CompareTokenOut, VenueQuoteRow } from "@/lib/compare/tokens";
import { COMPARE_TOKENS } from "@/lib/compare/tokens";

import styles from "./page.module.css";

const TOKENS: CompareTokenOut[] = ["MON", "WETH", "cbBTC", "XAUT0"];
const HIDDEN_MONAD_VENUES = new Set([
  "lfj-monad",
  "balancer-monad",
  "mento-monad",
  "clober-monad",
]);

async function fetchCompare(
  tokenOut: CompareTokenOut,
  options: { forceRefresh?: boolean; cachedOnly?: boolean } = {}
): Promise<CompareQuotesResponse> {
  const params = new URLSearchParams({ tokenOut });
  if (options.cachedOnly) {
    params.set("cachedOnly", "1");
  }
  if (options.forceRefresh) {
    params.set("refresh", "1");
    params.set("_", Date.now().toString());
  }
  const resp = await fetch(`/api/compare-quotes?${params}`, {
    cache: options.forceRefresh || options.cachedOnly ? "no-store" : "default",
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Compare API error ${resp.status}`);
  }
  return resp.json() as Promise<CompareQuotesResponse>;
}

function cellText(row: VenueQuoteRow, amountUsd: number): {
  text: string;
  slippage: string | null;
  status: string;
  slippageBps: number | null;
} {
  const quote = row.quotes.find((q) => q.amountUsd === amountUsd);
  if (!quote) return { text: "—", slippage: null, status: "na", slippageBps: null };
  if (quote.status === "ok" && quote.amountOutHuman) {
    const slippageBps =
      quote.slippageBps != null && Number.isFinite(quote.slippageBps) ? quote.slippageBps : null;
    const slippage = slippageBps != null ? `${slippageBps.toFixed(1)} bps` : null;
    return { text: quote.amountOutHuman, slippage, status: "ok", slippageBps };
  }
  if (quote.status === "error") return { text: "Error", slippage: null, status: "error", slippageBps: null };
  return { text: "N/A", slippage: null, status: "na", slippageBps: null };
}

/** Lowest buy slippage per notional column (markets-volume-tracker depth-table pattern). */
function bestBpsByAmount(rows: VenueQuoteRow[], amounts: number[]): Map<number, number> {
  const best = new Map<number, number>();
  for (const amount of amounts) {
    let min: number | null = null;
    for (const row of rows) {
      const q = row.quotes.find((x) => x.amountUsd === amount);
      if (q?.status === "ok" && q.slippageBps != null && Number.isFinite(q.slippageBps)) {
        if (min === null || q.slippageBps < min) min = q.slippageBps;
      }
    }
    if (min != null) best.set(amount, min);
  }
  return best;
}

function QuoteTable({
  title,
  subtitle,
  rows,
  amounts,
}: {
  title: string;
  subtitle: string;
  rows: VenueQuoteRow[];
  amounts: number[];
}) {
  const bestBps = bestBpsByAmount(rows, amounts);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        <p className={styles.sectionSub}>{subtitle}</p>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Venue</th>
              {amounts.map((amount) => (
                <th key={amount} scope="col">
                  ${amount.toLocaleString()} USDC
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.venueId} className={row.highlight ? styles.highlightRow : undefined}>
                <th scope="row">
                  <span className={styles.venueName}>
                    {row.venueName}
                    {row.highlight ? <span className={styles.badge}>Kuru</span> : null}
                  </span>
                  {row.volume24hUsd != null && row.volume24hUsd > 0 ? (
                    <span className={styles.venueMeta}>
                      ${(row.volume24hUsd / 1e6).toFixed(2)}M 24h vol
                    </span>
                  ) : null}
                </th>
                {amounts.map((amount) => {
                  const cell = cellText(row, amount);
                  const quote = row.quotes.find((q) => q.amountUsd === amount);
                  const columnBest = bestBps.get(amount);
                  const isBest =
                    cell.slippageBps != null &&
                    columnBest != null &&
                    Math.abs(cell.slippageBps - columnBest) < 1e-9;
                  const statusClass = styles[`cell_${cell.status}` as keyof typeof styles] ?? styles.cell_na;
                  return (
                    <td
                      key={amount}
                      className={`${statusClass}${isBest ? ` ${styles.cellBestBps}` : ""}`}
                      title={quote?.note}
                    >
                      <span className={styles.cellAmount}>{cell.text}</span>
                      {cell.slippage ? <span className={styles.cellSlippage}>{cell.slippage}</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ComparePage() {
  const [tokenOut, setTokenOut] = useState<CompareTokenOut>("WETH");
  const [dataByToken, setDataByToken] = useState<
    Partial<Record<CompareTokenOut, CompareQuotesResponse>>
  >({});
  const [loadingToken, setLoadingToken] = useState<CompareTokenOut | null>("WETH");
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const startedTokens = useRef(new Set<CompareTokenOut>());

  const load = useCallback(async (token: CompareTokenOut, forceRefresh = false) => {
    const id = ++requestId.current;
    setLoadingToken(token);
    setError(null);
    try {
      if (!forceRefresh) {
        try {
          const snapshot = await fetchCompare(token, { cachedOnly: true });
          if (requestId.current === id) {
            setDataByToken((previous) => ({ ...previous, [token]: snapshot }));
          }
        } catch {
          // No snapshot yet — fall through to live fetch.
        }
      }

      const next = await fetchCompare(token, { forceRefresh: true });
      if (requestId.current === id) {
        setDataByToken((previous) => ({ ...previous, [token]: next }));
      }
    } catch (err) {
      if (requestId.current === id) {
        setError(err instanceof Error ? err.message : "Failed to load quotes");
      }
    } finally {
      if (requestId.current === id) {
        setLoadingToken(null);
      }
    }
  }, []);

  useEffect(() => {
    if (startedTokens.current.has(tokenOut)) return;
    startedTokens.current.add(tokenOut);
    void load(tokenOut);
  }, [load, tokenOut]);

  const visible = dataByToken[tokenOut] ?? null;
  const loading = loadingToken === tokenOut;
  const visibleMonadRows =
    visible?.withinMonad.filter(
      (row) => !HIDDEN_MONAD_VENUES.has(row.venueId)
    ) ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow} aria-hidden="true" />
      <div className={styles.bgGrid} aria-hidden="true" />

      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <Link href="/" className={styles.backLink}>
            ← Dashboard
          </Link>
          <h1 className={styles.title}>USDC swap comparison</h1>
        </div>
        <div className={styles.topRight}>
          <p className={styles.updated}>
            {visible ? (
              <>
                {visible.cached ? "Cached · " : ""}
                {new Date(visible.quotedAt).toLocaleString()}
              </>
            ) : (
              "One-hop quotes only"
            )}
          </p>
          <button
            type="button"
            className={styles.reloadButton}
            onClick={() => void load(tokenOut, true)}
            disabled={loading}
          >
            {loading && visible ? "Reloading…" : "Reload quotes"}
          </button>
        </div>
      </header>

      <p className={styles.lede}>
        What you get selling USDC for {COMPARE_TOKENS[tokenOut].symbol} in a{" "}
        <strong>single direct market</strong> — no nested routes.
      </p>

      <div className={styles.tabs} role="tablist" aria-label="Output token">
        {TOKENS.map((token) => (
          <button
            key={token}
            type="button"
            role="tab"
            aria-selected={tokenOut === token}
            className={`${styles.tab} ${tokenOut === token ? styles.tabActive : ""}`}
            onClick={() => setTokenOut(token)}
          >
            {COMPARE_TOKENS[token].symbol}
          </button>
        ))}
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {!visible ? (
        <p className={styles.loading}>Fetching one-hop quotes across venues…</p>
      ) : (
        <>
          <QuoteTable
            title="Within Monad"
            subtitle="Kuru vs other Monad DEXs (DefiLlama volume ranking). Multi-hop aggregators excluded."
            rows={visibleMonadRows}
            amounts={visible.amountsUsd}
          />
          <QuoteTable
            title="Monad vs rest"
            subtitle="Kuru/Monad vs Jupiter, Hyperliquid, Coinbase, Binance, OKX, Bybit, and Lighter."
            rows={[
              ...visibleMonadRows.filter((r) => r.highlight),
              ...visible.vsRest,
            ]}
            amounts={visible.amountsUsd}
          />
          <p className={styles.footnote}>{visible.mappingNote}</p>
          <p className={styles.footnote}>
            Estimates only. One-hop / direct books and pools. Buy slippage is vs mid (or $100 reference). Green cells =
            lowest bps in that size column. Hover a cell for notes.
          </p>
        </>
      )}
    </div>
  );
}
