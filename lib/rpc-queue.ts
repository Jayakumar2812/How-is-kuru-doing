import "server-only";

const MAX_RETRIES = 6;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRpcPool(maxConcurrent: number, minGapMs: number) {
  let inFlight = 0;
  let lastRequestAt = 0;
  const waiters: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    if (inFlight < maxConcurrent) {
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < minGapMs) {
        await sleep(minGapMs - elapsed);
      }
      inFlight += 1;
      lastRequestAt = Date.now();
      return;
    }

    await new Promise<void>((resolve) => waiters.push(resolve));
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < minGapMs) {
      await sleep(minGapMs - elapsed);
    }
    inFlight += 1;
    lastRequestAt = Date.now();
  }

  function releaseSlot(): void {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  return async function poolFetch(url: string, init: RequestInit): Promise<Response> {
    await acquireSlot();
    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const resp = await fetch(url, init);
        if (resp.status !== 429) {
          return resp;
        }
        const retryAfter = Number.parseInt(resp.headers.get("retry-after") ?? "", 10);
        const backoffMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(30_000, 1000 * 2 ** attempt);
        await sleep(backoffMs);
      }
      throw new Error("RPC rate limited (HTTP 429) — try again shortly");
    } finally {
      releaseSlot();
    }
  };
}

const mainRpcFetch = createRpcPool(
  parsePositiveInt(process.env.RPC_MAX_CONCURRENT, 4),
  parsePositiveInt(process.env.RPC_MIN_GAP_MS, 250)
);

const traceRpcFetchImpl = createRpcPool(
  parsePositiveInt(process.env.RPC_TRACE_MAX_CONCURRENT, 2),
  parsePositiveInt(process.env.RPC_TRACE_MIN_GAP_MS, 500)
);

export async function rpcFetch(url: string, init: RequestInit): Promise<Response> {
  return mainRpcFetch(url, init);
}

export async function traceRpcFetch(url: string, init: RequestInit): Promise<Response> {
  return traceRpcFetchImpl(url, init);
}
