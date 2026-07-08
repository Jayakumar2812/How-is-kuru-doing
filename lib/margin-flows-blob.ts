import "server-only";

import { get, put } from "@vercel/blob";

import type { MarginFlowsResponse } from "@/lib/types";

const BLOB_PREFIX = "margin-flows";

function blobPathname(dateKey: string): string {
  return `${BLOB_PREFIX}/${dateKey}.json`;
}

export function isMarginFlowsBlobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN) || process.env.VERCEL === "1";
}

export async function readMarginFlowsFromBlob(
  dateKey: string
): Promise<MarginFlowsResponse | null> {
  if (!isMarginFlowsBlobEnabled()) {
    return null;
  }

  try {
    const result = await get(blobPathname(dateKey), { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }

    const text = await new Response(result.stream).text();
    const parsed = JSON.parse(text) as MarginFlowsResponse;
    if (parsed.utcWindow?.dateKey !== dateKey) {
      return null;
    }

    return {
      ...parsed,
      cached: true,
    };
  } catch (err) {
    console.warn("margin-flows blob read failed", err);
    return null;
  }
}

export async function writeMarginFlowsToBlob(
  dateKey: string,
  response: MarginFlowsResponse
): Promise<void> {
  if (!isMarginFlowsBlobEnabled()) {
    return;
  }

  try {
    const payload: MarginFlowsResponse = {
      ...response,
      cached: false,
    };

    await put(blobPathname(dateKey), JSON.stringify(payload), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    console.warn("margin-flows blob write failed", err);
  }
}
