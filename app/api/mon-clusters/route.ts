import { NextRequest, NextResponse } from "next/server";

import { getMonClusters } from "@/lib/mon-clusters/orchestrate";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const data = await getMonClusters(forceRefresh);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": forceRefresh ? "no-store" : "public, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (err) {
    console.error("mon-clusters API failed", err);
    return NextResponse.json({ error: "Failed to load MON cluster data" }, { status: 500 });
  }
}
