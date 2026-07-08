import { NextRequest, NextResponse } from "next/server";

import {
  blocksFromScan,
  finalizeKuruWindowResponse,
  mergeIncrementalWindow,
} from "@/lib/kuru-window-build";
import {
  getCachedKuruWindow,
  getKuruWindowScan,
  getLatestKuruWindowSnapshot,
  setCachedKuruWindow,
  setKuruWindowScan,
} from "@/lib/kuru-window-cache";
import { readKuruWindowFromBlob, writeKuruWindowToBlob } from "@/lib/kuru-window-blob";
import { scanKuruWindow } from "@/lib/kuru-window-scan";
import { getLatestBlock } from "@/lib/rpc";
import type { KuruWindowResponse } from "@/lib/types";

export const maxDuration = 120;

const DEFAULT_COUNT = 100;
const MAX_COUNT = 100;

async function getIncrementalBase(): Promise<KuruWindowResponse | null> {
  const memorySnapshot = getLatestKuruWindowSnapshot();
  if (memorySnapshot) {
    return memorySnapshot;
  }

  return readKuruWindowFromBlob();
}

async function buildKuruWindowResponse(
  latestBlock: number,
  count: number
): Promise<KuruWindowResponse> {
  const fromBlock = Math.max(1, latestBlock - count + 1);
  const base = await getIncrementalBase();

  if (base && base.latestBlock < latestBlock) {
    const gap = latestBlock - base.latestBlock;
    if (gap > 0 && gap < count) {
      const scanFrom = base.latestBlock + 1;
      const scan = await scanKuruWindow(scanFrom, latestBlock);
      const newBlocks = blocksFromScan(scanFrom, latestBlock, scan);
      const response = mergeIncrementalWindow(base, newBlocks, latestBlock, count);

      const cacheKey = `${response.fromBlock}-${latestBlock}`;
      setCachedKuruWindow(cacheKey, response);
      await writeKuruWindowToBlob(response);
      return response;
    }
  }

  const scan = await scanKuruWindow(fromBlock, latestBlock);
  const response = finalizeKuruWindowResponse(
    latestBlock,
    count,
    blocksFromScan(fromBlock, latestBlock, scan)
  );

  const cacheKey = `${fromBlock}-${latestBlock}`;
  setCachedKuruWindow(cacheKey, response);
  await writeKuruWindowToBlob(response);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const cachedOnly = params.get("cachedOnly") === "1";
    const count = Math.min(
      Math.max(parseInt(params.get("count") ?? String(DEFAULT_COUNT), 10) || DEFAULT_COUNT, 1),
      MAX_COUNT
    );

    if (cachedOnly) {
      const memorySnapshot = getLatestKuruWindowSnapshot();
      if (memorySnapshot) {
        return NextResponse.json(
          { ...memorySnapshot, cached: true, stale: true },
          { headers: { "Cache-Control": "public, max-age=60" } }
        );
      }

      const blobCached = await readKuruWindowFromBlob();
      if (blobCached) {
        return NextResponse.json(blobCached, {
          headers: { "Cache-Control": "public, max-age=60" },
        });
      }

      return NextResponse.json({ error: "No cached Kuru window snapshot" }, { status: 404 });
    }

    const toBlockParam = params.get("toBlock");
    const latestBlock =
      toBlockParam !== null ? parseInt(toBlockParam, 10) : await getLatestBlock();

    if (!Number.isFinite(latestBlock) || latestBlock < 1) {
      return NextResponse.json({ error: "invalid toBlock" }, { status: 400 });
    }

    const fromBlock = Math.max(1, latestBlock - count + 1);
    const cacheKey = `${fromBlock}-${latestBlock}`;
    const memoryCached = getCachedKuruWindow(cacheKey);
    if (memoryCached) {
      return NextResponse.json(memoryCached, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const inFlight = getKuruWindowScan(cacheKey);
    const response = inFlight ?? buildKuruWindowResponse(latestBlock, count);
    if (!inFlight) {
      setKuruWindowScan(cacheKey, response);
    }

    return NextResponse.json(await response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("kuru-window API failed", err);
    return NextResponse.json({ error: "Failed to load Kuru activity window" }, { status: 500 });
  }
}
