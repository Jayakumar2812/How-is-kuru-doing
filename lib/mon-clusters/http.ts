export type HttpOk<T> = { ok: true; status: number; data: T };
export type HttpErr = { ok: false; status: number | null; reason: string };
export type HttpResult<T> = HttpOk<T> | HttpErr;

const DEFAULT_TIMEOUT_MS = 8_000;

function reasonFromStatus(status: number, bodyPreview: string): string {
  if (status === 401 || status === 403) {
    if (/api key|authentication|credentials|unauthorized/i.test(bodyPreview)) {
      return "API key missing or rejected";
    }
    return `HTTP ${status} (blocked or unauthorized)`;
  }
  if (status === 429) return "Rate limited (429)";
  if (status === 451 || /restricted location|blocked access from your country|eligibility/i.test(bodyPreview)) {
    return "Unavailable from this region";
  }
  if (status >= 500) return `Upstream error (${status})`;
  return `HTTP ${status}`;
}

export async function fetchJson<T>(
  url: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
      body: options.body,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        if (!response.ok) {
          return { ok: false, status: response.status, reason: reasonFromStatus(response.status, text.slice(0, 240)) };
        }
        return { ok: false, status: response.status, reason: "Invalid JSON from upstream" };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: reasonFromStatus(response.status, text.slice(0, 240)),
      };
    }

    return { ok: true, status: response.status, data: parsed as T };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      return { ok: false, status: null, reason: "Request timed out" };
    }
    return { ok: false, status: null, reason: err instanceof Error ? err.message : "Network error" };
  } finally {
    clearTimeout(timeout);
  }
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
