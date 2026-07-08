export interface UtcDayWindow {
  dateKey: string;
  startUtc: string;
  endUtc: string;
  startTs: number;
  endTs: number;
  label: string;
}

function formatUtcDayLabel(date: Date): string {
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = date.getUTCFullYear();
  return `Previous UTC day: ${day} ${month} ${year} (00:00:00Z – 23:59:59Z)`;
}

/** Returns the previous completed UTC calendar day (yesterday UTC). */
export function getPreviousUtcDayWindow(): UtcDayWindow {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const prevStartMs = todayStart - 86_400_000;
  const prevEndMs = todayStart - 1;

  const prevDate = new Date(prevStartMs);
  const dateKey = prevDate.toISOString().slice(0, 10);

  return {
    dateKey,
    startUtc: new Date(prevStartMs).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    endUtc: new Date(prevEndMs).toISOString().replace(/\.\d{3}Z$/, ".999Z"),
    startTs: Math.floor(prevStartMs / 1000),
    endTs: Math.floor(prevEndMs / 1000),
    label: formatUtcDayLabel(prevDate),
  };
}
