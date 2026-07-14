import { NextRequest, NextResponse } from "next/server";

import {
  buildCompareQuotes,
  getCachedCompareQuotes,
  isCompareTokenOut,
} from "@/lib/compare/orchestrate";
import type { CompareTokenOut } from "@/lib/compare/tokens";

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  try {
    const tokenParam = request.nextUrl.searchParams.get("tokenOut") ?? "WETH";
    if (!isCompareTokenOut(tokenParam)) {
      return NextResponse.json(
        { error: "tokenOut must be one of MON, WETH, cbBTC, XAUT0" },
        { status: 400 }
      );
    }

    const tokenOut = tokenParam as CompareTokenOut;
    const cachedOnly = request.nextUrl.searchParams.get("cachedOnly") === "1";
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";

    if (cachedOnly) {
      const snapshot = await getCachedCompareQuotes(tokenOut);
      if (!snapshot) {
        return NextResponse.json(
          { error: "No cached compare-quotes snapshot" },
          { status: 404 }
        );
      }
      return NextResponse.json(snapshot, {
        headers: { "Cache-Control": "public, max-age=30" },
      });
    }

    const data = await buildCompareQuotes(tokenOut, forceRefresh);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": forceRefresh
          ? "no-store"
          : "public, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (err) {
    console.error("compare-quotes API failed", err);
    return NextResponse.json({ error: "Failed to load swap comparison quotes" }, { status: 500 });
  }
}
