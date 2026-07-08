import type { MarginFlowsResponse } from "@/lib/types";

interface CacheEntry {
  dateKey: string;
  result: MarginFlowsResponse;
  scannedAt: string;
  blockRange?: { from: number; to: number };
}

const globalStore = globalThis as typeof globalThis & {
  __marginFlowsCache?: CacheEntry | null;
  __marginFlowsScan?: { dateKey: string; promise: Promise<MarginFlowsResponse> } | null;
};

function getCache(): CacheEntry | null {
  return globalStore.__marginFlowsCache ?? null;
}

function setCache(entry: CacheEntry | null): void {
  globalStore.__marginFlowsCache = entry;
}

export function getCachedMarginFlows(dateKey: string): MarginFlowsResponse | null {
  const cache = getCache();
  if (cache?.dateKey === dateKey) {
    return { ...cache.result, cached: true, scannedAt: cache.scannedAt };
  }
  return null;
}

export function getCachedBlockRange(dateKey: string): { from: number; to: number } | null {
  const cache = getCache();
  if (cache?.dateKey === dateKey && cache.blockRange) {
    return cache.blockRange;
  }
  return null;
}

export function setCachedMarginFlows(
  dateKey: string,
  result: MarginFlowsResponse,
  blockRange?: { from: number; to: number }
): void {
  setCache({
    dateKey,
    result,
    scannedAt: result.scannedAt,
    blockRange,
  });
}

export function getMarginFlowsScan(dateKey: string): Promise<MarginFlowsResponse> | null {
  const scan = globalStore.__marginFlowsScan;
  if (scan?.dateKey === dateKey) {
    return scan.promise;
  }
  return null;
}

export function setMarginFlowsScan(dateKey: string, promise: Promise<MarginFlowsResponse>): void {
  globalStore.__marginFlowsScan = { dateKey, promise };
  promise.finally(() => {
    if (globalStore.__marginFlowsScan?.promise === promise) {
      globalStore.__marginFlowsScan = null;
    }
  });
}
