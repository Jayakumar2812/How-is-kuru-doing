import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_TOKEN, scanMarginFlows } from "@/lib/margin-flows";
import {
  readMarginFlowsFromBlob,
  writeMarginFlowsToBlob,
} from "@/lib/margin-flows-blob";
import {
  getCachedBlockRange,
  getCachedMarginFlows,
  getMarginFlowsScan,
  setCachedMarginFlows,
  setMarginFlowsScan,
} from "@/lib/margin-flows-cache";
import { resolveUtcDayToBlocks } from "@/lib/rpc";
import type { MarginFlowsResponse } from "@/lib/types";
import { getPreviousUtcDayWindow } from "@/lib/utc";

export const maxDuration = 300;

function isCronRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

async function buildMarginFlowsResponse(): Promise<MarginFlowsResponse> {
  const utcWindow = getPreviousUtcDayWindow();
  const cachedRange = getCachedBlockRange(utcWindow.dateKey);
  const blockRange = cachedRange
    ? { fromBlock: cachedRange.from, toBlock: cachedRange.to }
    : await resolveUtcDayToBlocks(utcWindow.startTs, utcWindow.endTs);
  const { fromBlock, toBlock } = blockRange;

  const tokens = await scanMarginFlows(fromBlock, toBlock);
  const scannedAt = new Date().toISOString();

  const response: MarginFlowsResponse = {
    utcWindow: {
      dateKey: utcWindow.dateKey,
      start: utcWindow.startUtc,
      end: utcWindow.endUtc,
      label: utcWindow.label,
    },
    blockRange: { from: fromBlock, to: toBlock },
    tokens,
    defaultToken: DEFAULT_TOKEN,
    cached: false,
    scannedAt,
  };

  setCachedMarginFlows(utcWindow.dateKey, response, { from: fromBlock, to: toBlock });
  await writeMarginFlowsToBlob(utcWindow.dateKey, response);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const utcWindow = getPreviousUtcDayWindow();
    const cachedOnly = request.nextUrl.searchParams.get("cachedOnly") === "1";
    const forceRefresh = isCronRequest(request);

    if (cachedOnly) {
      const memoryCached = getCachedMarginFlows(utcWindow.dateKey);
      if (memoryCached) {
        return NextResponse.json(memoryCached, {
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      }

      const blobCached = await readMarginFlowsFromBlob(utcWindow.dateKey);
      if (blobCached) {
        return NextResponse.json(blobCached, {
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      }

      return NextResponse.json({ error: "No cached MarginAccount flows snapshot" }, { status: 404 });
    }

    if (!forceRefresh) {
      const memoryCached = getCachedMarginFlows(utcWindow.dateKey);
      if (memoryCached) {
        return NextResponse.json(memoryCached, {
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      }

      const blobCached = await readMarginFlowsFromBlob(utcWindow.dateKey);
      if (blobCached) {
        setCachedMarginFlows(utcWindow.dateKey, blobCached, {
          from: blobCached.blockRange.from,
          to: blobCached.blockRange.to,
        });
        return NextResponse.json(blobCached, {
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      }
    }

    const inFlight = getMarginFlowsScan(utcWindow.dateKey);
    const response = inFlight ?? buildMarginFlowsResponse();
    if (!inFlight) {
      setMarginFlowsScan(utcWindow.dateKey, response);
    }

    return NextResponse.json(await response, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    console.error("margin-flows API failed", err);
    return NextResponse.json({ error: "Failed to load MarginAccount flows" }, { status: 500 });
  }
}
