import "server-only";

import { get, put } from "@vercel/blob";

import type { CompareQuotesResponse, CompareTokenOut } from "@/lib/compare/tokens";

const BLOB_PREFIX = "compare-quotes";

function blobPathname(tokenOut: CompareTokenOut): string {
  return `${BLOB_PREFIX}/${tokenOut}.json`;
}

export function isCompareBlobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN) || process.env.VERCEL === "1";
}

function isValidCompareSnapshot(
  parsed: CompareQuotesResponse,
  tokenOut: CompareTokenOut
): boolean {
  return (
    parsed.tokenOut === tokenOut &&
    Array.isArray(parsed.withinMonad) &&
    Array.isArray(parsed.vsRest) &&
    typeof parsed.quotedAt === "string" &&
    parsed.quotedAt.length > 0
  );
}

export async function readCompareQuotesFromBlob(
  tokenOut: CompareTokenOut
): Promise<CompareQuotesResponse | null> {
  if (!isCompareBlobEnabled()) {
    return null;
  }

  try {
    const result = await get(blobPathname(tokenOut), { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }

    const text = await new Response(result.stream).text();
    const parsed = JSON.parse(text) as CompareQuotesResponse;
    if (!isValidCompareSnapshot(parsed, tokenOut)) {
      return null;
    }

    return {
      ...parsed,
      cached: true,
    };
  } catch (err) {
    console.warn("compare-quotes blob read failed", err);
    return null;
  }
}

export async function writeCompareQuotesToBlob(
  tokenOut: CompareTokenOut,
  response: CompareQuotesResponse
): Promise<void> {
  if (!isCompareBlobEnabled()) {
    return;
  }

  try {
    const payload: CompareQuotesResponse = {
      ...response,
      tokenOut,
      cached: false,
    };

    await put(blobPathname(tokenOut), JSON.stringify(payload), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    console.warn("compare-quotes blob write failed", err);
  }
}
