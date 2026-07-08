import "server-only";

const MAX_CONCURRENT = 2;
const MIN_GAP_MS = 250;
const MAX_RETRIES = 6;

let inFlight = 0;
let lastRequestAt = 0;
const waiters: Array<() => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_GAP_MS) {
      await sleep(MIN_GAP_MS - elapsed);
    }
    inFlight += 1;
    lastRequestAt = Date.now();
    return;
  }

  await new Promise<void>((resolve) => waiters.push(resolve));
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_GAP_MS) {
    await sleep(MIN_GAP_MS - elapsed);
  }
  inFlight += 1;
  lastRequestAt = Date.now();
}

function releaseSlot(): void {
  inFlight -= 1;
  const next = waiters.shift();
  if (next) next();
}

export async function rpcFetch(url: string, init: RequestInit): Promise<Response> {
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
}
