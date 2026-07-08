import { NextRequest, NextResponse } from "next/server";

import { getCachedKuruWindow, setCachedKuruWindow } from "@/lib/kuru-window-cache";
import { scanKuruWindow } from "@/lib/kuru-window-scan";
import { getLatestBlock } from "@/lib/rpc";
import type { BlockStatus, KuruWindowResponse } from "@/lib/types";

export const maxDuration = 120;

const DEFAULT_COUNT = 100;
const MAX_COUNT = 100;

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const count = Math.min(
      Math.max(parseInt(params.get("count") ?? String(DEFAULT_COUNT), 10) || DEFAULT_COUNT, 1),
      MAX_COUNT
    );

    const toBlockParam = params.get("toBlock");
    const latestBlock =
      toBlockParam !== null ? parseInt(toBlockParam, 10) : await getLatestBlock();

    if (!Number.isFinite(latestBlock) || latestBlock < 1) {
      return NextResponse.json({ error: "invalid toBlock" }, { status: 400 });
    }

    const fromBlock = Math.max(1, latestBlock - count + 1);
    const cacheKey = `${fromBlock}-${latestBlock}`;
    const cached = getCachedKuruWindow(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const { traceBlocks, txBlocks, timestamps } = await scanKuruWindow(fromBlock, latestBlock);

    const blocks: BlockStatus[] = [];
    for (let n = latestBlock; n >= fromBlock; n--) {
      const viaTrace = traceBlocks.has(n);
      const viaTx = txBlocks.has(n);
      blocks.push({
        number: n,
        hasKuru: viaTrace || viaTx,
        viaTrace,
        viaTx,
        timestamp: timestamps.get(n) ?? 0,
      });
    }

    const activeCount = blocks.filter((b) => b.hasKuru).length;
    const activePct = count > 0 ? Math.round((activeCount / count) * 1000) / 10 : 0;

    const response: KuruWindowResponse = {
      latestBlock,
      fromBlock,
      count,
      blocks,
      activeCount,
      activePct,
    };

    setCachedKuruWindow(cacheKey, response);

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("kuru-window API failed", err);
    return NextResponse.json({ error: "Failed to load Kuru activity window" }, { status: 500 });
  }
}
