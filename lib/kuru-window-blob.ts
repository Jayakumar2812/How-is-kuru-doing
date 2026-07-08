import "server-only";

import { get, put } from "@vercel/blob";

import type { KuruWindowResponse } from "@/lib/types";

const BLOB_PATHNAME = "kuru-window/latest.json";

export function isKuruWindowBlobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN) || process.env.VERCEL === "1";
}

export async function readKuruWindowFromBlob(): Promise<KuruWindowResponse | null> {
  if (!isKuruWindowBlobEnabled()) {
    return null;
  }

  try {
    const result = await get(BLOB_PATHNAME, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }

    const text = await new Response(result.stream).text();
    const parsed = JSON.parse(text) as KuruWindowResponse;
    if (!parsed.blocks?.length || !Number.isFinite(parsed.latestBlock)) {
      return null;
    }

    return {
      ...parsed,
      cached: true,
      stale: true,
    };
  } catch (err) {
    console.warn("kuru-window blob read failed", err);
    return null;
  }
}

export async function writeKuruWindowToBlob(response: KuruWindowResponse): Promise<void> {
  if (!isKuruWindowBlobEnabled()) {
    return;
  }

  try {
    const payload: KuruWindowResponse = {
      ...response,
      cached: false,
      stale: false,
      scannedAt: new Date().toISOString(),
    };

    await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    console.warn("kuru-window blob write failed", err);
  }
}
