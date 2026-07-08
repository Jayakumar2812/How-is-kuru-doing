import type { KuruWindowResponse } from "@/lib/types";

interface CacheEntry {
  key: string;
  response: KuruWindowResponse;
  expiresAt: number;
}

const globalStore = globalThis as typeof globalThis & {
  __kuruWindowCache?: CacheEntry | null;
};

const TTL_MS = 20_000;

function getCache(): CacheEntry | null {
  return globalStore.__kuruWindowCache ?? null;
}

function setCache(entry: CacheEntry | null): void {
  globalStore.__kuruWindowCache = entry;
}

export function getCachedKuruWindow(key: string): KuruWindowResponse | null {
  const cache = getCache();
  if (!cache || cache.key !== key || cache.expiresAt <= Date.now()) {
    return null;
  }
  return cache.response;
}

export function setCachedKuruWindow(key: string, response: KuruWindowResponse): void {
  setCache({
    key,
    response,
    expiresAt: Date.now() + TTL_MS,
  });
}
