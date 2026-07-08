import type { KuruWindowScanResult } from "@/lib/kuru-window-scan";
import type { BlockStatus, KuruWindowResponse } from "@/lib/types";

export function blocksFromScan(
  fromBlock: number,
  toBlock: number,
  scan: KuruWindowScanResult
): BlockStatus[] {
  const blocks: BlockStatus[] = [];
  for (let n = toBlock; n >= fromBlock; n--) {
    const viaTrace = scan.traceBlocks.has(n);
    const viaTx = scan.txBlocks.has(n);
    blocks.push({
      number: n,
      hasKuru: viaTrace || viaTx,
      viaTrace,
      viaTx,
      timestamp: scan.timestamps.get(n) ?? 0,
    });
  }
  return blocks;
}

export function finalizeKuruWindowResponse(
  latestBlock: number,
  count: number,
  blocks: BlockStatus[]
): KuruWindowResponse {
  const trimmed = blocks.slice(0, count);
  const fromBlock = trimmed[trimmed.length - 1]?.number ?? latestBlock;
  const activeCount = trimmed.filter((b) => b.hasKuru).length;
  const activePct = count > 0 ? Math.round((activeCount / count) * 1000) / 10 : 0;

  return {
    latestBlock,
    fromBlock,
    count,
    blocks: trimmed,
    activeCount,
    activePct,
    cached: false,
    stale: false,
    scannedAt: new Date().toISOString(),
  };
}

export function mergeIncrementalWindow(
  base: KuruWindowResponse,
  newBlocks: BlockStatus[],
  latestBlock: number,
  count: number
): KuruWindowResponse {
  const newestScanned = newBlocks[0]?.number ?? latestBlock;
  const existing = base.blocks.filter((block) => block.number < newestScanned);
  return finalizeKuruWindowResponse(latestBlock, count, [...newBlocks, ...existing]);
}
