"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import type { BlockStatus, KuruWindowResponse, MarginFlowsResponse, TokenFlow } from "@/lib/types";
import { formatCompactFlowLabel, formatCompactNetLabel } from "@/lib/tokens";

import styles from "./page.module.css";

const POLL_INTERVAL_MS = 20_000;
const WINDOW_COUNT = 100;
const FLOWS_LOAD_DELAY_MS = 5_000;

async function fetchLatestBlock(): Promise<number> {
  const resp = await fetch("/api/latest-block");
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Latest block API error ${resp.status}`);
  }
  const body = (await resp.json()) as { latestBlock: number };
  return body.latestBlock;
}

async function fetchWindow(toBlock: number): Promise<KuruWindowResponse> {
  const resp = await fetch(`/api/kuru-window?count=${WINDOW_COUNT}&toBlock=${toBlock}`);
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `API error ${resp.status}`);
  }
  return resp.json() as Promise<KuruWindowResponse>;
}

async function fetchMarginFlows(): Promise<MarginFlowsResponse> {
  const resp = await fetch("/api/margin-flows");
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Margin flows API error ${resp.status}`);
  }
  return resp.json() as Promise<MarginFlowsResponse>;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "—";
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

function hitLabel(block: BlockStatus): string {
  if (block.viaTrace && block.viaTx) return "contains direct Kuru tx + trace of Kuru in the block";
  if (block.viaTrace) return "contains trace of Kuru in the block";
  if (block.viaTx) return "contains direct Kuru tx";
  return "no activity";
}

function shortBlock(n: number): string {
  return n.toLocaleString().slice(-4);
}

export default function HomePage() {
  const [data, setData] = useState<KuruWindowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [newBlockIds, setNewBlockIds] = useState<Set<number>>(new Set());
  const [hoveredBlock, setHoveredBlock] = useState<BlockStatus | null>(null);
  const [flowsData, setFlowsData] = useState<MarginFlowsResponse | null>(null);
  const [flowsLoading, setFlowsLoading] = useState(true);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<string>("");

  const latestBlockRef = useRef<number | null>(null);
  const fetchingRef = useRef(false);
  const dataRef = useRef<KuruWindowResponse | null>(null);
  const chainScrollRef = useRef<HTMLDivElement>(null);
  const initialLoadRef = useRef(true);
  dataRef.current = data;

  const scrollToLatest = useCallback((smooth = true) => {
    const el = chainScrollRef.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollWidth, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      const latest = await fetchLatestBlock();
      const prev = latestBlockRef.current;

      if (!force && prev !== null && latest === prev && dataRef.current !== null) {
        return;
      }

      const window = await fetchWindow(latest);

      if (prev !== null && latest > prev) {
        const fresh = new Set<number>();
        for (let n = prev + 1; n <= latest; n++) fresh.add(n);
        setNewBlockIds(fresh);
        setTimeout(() => setNewBlockIds(new Set()), 2000);
      }

      latestBlockRef.current = latest;
      setData(window);
      setError(null);
      setLastUpdated(new Date());

      requestAnimationFrame(() => scrollToLatest(!initialLoadRef.current));
      initialLoadRef.current = false;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [scrollToLatest]);

  useEffect(() => {
    void refresh(true);
    const id = setInterval(() => void refresh(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void (async () => {
        try {
          const flows = await fetchMarginFlows();
          setFlowsData(flows);
          setSelectedToken((prev) => prev || flows.defaultToken);
          setFlowsError(null);
        } catch (err) {
          setFlowsError(err instanceof Error ? err.message : "Failed to load margin flows");
        } finally {
          setFlowsLoading(false);
        }
      })();
    }, FLOWS_LOAD_DELAY_MS);

    return () => clearTimeout(timeoutId);
  }, []);

  const chainBlocks = data ? [...data.blocks].reverse() : [];
  const latestBlock = data?.blocks[0] ?? null;
  const selectedFlow: TokenFlow | undefined =
    flowsData?.tokens.find((t) => t.address === selectedToken) ??
    flowsData?.tokens.find((t) => t.address === flowsData.defaultToken);

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow} aria-hidden="true" />
      <div className={styles.bgGrid} aria-hidden="true" />

      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <div className={styles.livePill}>
            <span className={styles.liveDot} />
            Live
          </div>
          <h1 className={styles.title}>How is Kuru doing?</h1>
        </div>

        <div className={styles.topRight}>
          {latestBlock && (
            <div className={`${styles.nowMood} ${latestBlock.hasKuru ? styles.happy : styles.sad}`}>
              <span className={styles.nowEmoji}>{latestBlock.hasKuru ? "😊" : "😢"}</span>
              <span>
                {latestBlock.hasKuru ? "Kuru active" : "Quiet block"} · #
                {latestBlock.number.toLocaleString()}
              </span>
            </div>
          )}
          {data && (
            <>
              <div className={styles.statChip}>
                <span className={styles.statLabel}>Active</span>
                <span className={styles.statValue}>{data.activePct}%</span>
              </div>
              {lastUpdated && (
                <span className={styles.updatedAt}>{lastUpdated.toLocaleTimeString()}</span>
              )}
            </>
          )}
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
          {data && " — showing last successful data"}
        </div>
      )}

      <section className={styles.chainSection} aria-label="Blockchain">
        <p className={styles.scrollHint}>
          {loading && !data
            ? "Batching txs + traces across 100 blocks…"
            : "Scroll horizontally · ← older blocks · newer blocks →"}
        </p>

        <div className={styles.chainOuter}>
          <div className={styles.fadeLeft} aria-hidden="true" />
          <div className={styles.fadeRight} aria-hidden="true" />
          <div className={styles.chainRail} aria-hidden="true" />

          <div ref={chainScrollRef} className={styles.chainScroll}>
            <div className={styles.chainRow}>
              {loading && !data
                ? Array.from({ length: 30 }, (_, i) => (
                    <Fragment key={`sk-${i}`}>
                      {i > 0 && <div className={`${styles.connector} ${styles.connectorSkeleton}`} />}
                      <div className={`${styles.block} ${styles.skeleton}`} />
                    </Fragment>
                  ))
                : chainBlocks.map((block, index) => {
                    const isLatest = block.number === data?.latestBlock;
                    const isNew = newBlockIds.has(block.number);
                    const prevBlock = index > 0 ? chainBlocks[index - 1] : null;
                    const linkActive = prevBlock?.hasKuru && block.hasKuru;

                    return (
                      <Fragment key={block.number}>
                        {index > 0 && (
                          <div
                            className={`${styles.connector} ${linkActive ? styles.connectorActive : styles.connectorIdle}`}
                            aria-hidden="true"
                          >
                            <span className={styles.connectorPulse} />
                          </div>
                        )}
                        <button
                          type="button"
                          className={[
                            styles.block,
                            block.hasKuru ? styles.blockActive : styles.blockIdle,
                            isLatest ? styles.blockTip : "",
                            isNew ? styles.blockNew : "",
                            !loading ? styles.blockEnter : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{ animationDelay: `${Math.min(index * 8, 400)}ms` }}
                          onMouseEnter={() => setHoveredBlock(block)}
                          onMouseLeave={() => setHoveredBlock(null)}
                          onFocus={() => setHoveredBlock(block)}
                          onBlur={() => setHoveredBlock(null)}
                          aria-label={`Block ${block.number}, ${hitLabel(block)}`}
                        >
                          {isLatest && <span className={styles.tipBadge}>tip</span>}
                          <span className={styles.blockEmoji}>{block.hasKuru ? "😊" : "😢"}</span>
                          <span className={styles.blockNum}>…{shortBlock(block.number)}</span>
                        </button>
                      </Fragment>
                    );
                  })}
            </div>
          </div>
        </div>

        {hoveredBlock ? (
          <div className={styles.tooltip}>
            <span className={styles.tooltipEmoji}>{hoveredBlock.hasKuru ? "😊" : "😢"}</span>
            <div>
              <strong>Block {hoveredBlock.number.toLocaleString()}</strong>
              <p>
                {hitLabel(hoveredBlock)} · {formatRelativeTime(hoveredBlock.timestamp)}
              </p>
            </div>
          </div>
        ) : (
          <p className={styles.tooltipPlaceholder}>Hover a block for details</p>
        )}
      </section>

      <section className={styles.flowsSection} aria-label="MarginAccount flows">
        <div className={styles.flowsHeader}>
          <div>
            <h2 className={styles.flowsTitle}>MarginAccount flows</h2>
            {flowsData ? (
              <p className={styles.flowsWindow}>{flowsData.utcWindow.label}</p>
            ) : (
              <p className={styles.flowsWindow}>
                Scanning previous UTC day via batched RPC… may take a few minutes.
              </p>
            )}
            <p className={styles.flowsNote}>
              Complete previous UTC day · updates after midnight UTC
              {flowsData?.scannedAt && (
                <> · scanned {new Date(flowsData.scannedAt).toLocaleString()}</>
              )}
            </p>
          </div>

          {flowsData && flowsData.tokens.length > 0 && (
            <label className={styles.tokenSelectWrap}>
              <span className={styles.tokenSelectLabel}>Token</span>
              <select
                className={styles.tokenSelect}
                value={selectedToken || flowsData.defaultToken}
                onChange={(e) => setSelectedToken(e.target.value)}
              >
                {flowsData.tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {flowsError && (
          <div className={styles.flowsError} role="alert">
            {flowsError}
          </div>
        )}

        {flowsLoading && !flowsData ? (
          <div className={styles.flowsCards}>
            <div className={`${styles.flowCard} ${styles.skeleton}`} />
            <div className={`${styles.flowCard} ${styles.skeleton}`} />
          </div>
        ) : selectedFlow ? (
          <>
            <div className={styles.flowsCards}>
              <div className={`${styles.flowCard} ${styles.inflowCard}`}>
                <span className={styles.flowCardLabel}>Inflow (deposits)</span>
                <span className={styles.flowCardValue}>
                  {formatCompactFlowLabel(selectedFlow.inflow, selectedFlow.symbol, "in")}
                </span>
                <span className={styles.flowCardMeta}>
                  {selectedFlow.depositCount.toLocaleString()} deposit
                  {selectedFlow.depositCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className={`${styles.flowCard} ${styles.outflowCard}`}>
                <span className={styles.flowCardLabel}>Outflow (withdrawals)</span>
                <span className={styles.flowCardValue}>
                  {formatCompactFlowLabel(selectedFlow.outflow, selectedFlow.symbol, "out")}
                </span>
                <span className={styles.flowCardMeta}>
                  {selectedFlow.withdrawalCount.toLocaleString()} withdrawal
                  {selectedFlow.withdrawalCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <p className={styles.flowNet}>
              Net: <strong>{formatCompactNetLabel(selectedFlow.net, selectedFlow.symbol)}</strong>
            </p>
          </>
        ) : (
          !flowsLoading && (
            <p className={styles.flowsEmpty}>No MarginAccount deposits or withdrawals for this day.</p>
          )
        )}
      </section>

      <footer className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.legendHappy}`} />
          Kuru active
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendDot} ${styles.legendSad}`} />
          No activity
        </span>
      </footer>
    </div>
  );
}
