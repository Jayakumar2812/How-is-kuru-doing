import { NextResponse } from "next/server";

import { getLatestBlock } from "@/lib/rpc";

export async function GET() {
  try {
    const latestBlock = await getLatestBlock();
    return NextResponse.json({ latestBlock }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("latest-block API failed", err);
    return NextResponse.json({ error: "Failed to load latest block" }, { status: 500 });
  }
}
