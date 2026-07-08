import { kuruAddressSet } from "@/lib/addresses";
import {
  type CallTraceNode,
  getBlockTraces,
  getBlocksWithTransactions,
} from "@/lib/rpc";

export interface KuruWindowScanResult {
  traceBlocks: Set<number>;
  txBlocks: Set<number>;
  timestamps: Map<number, number>;
}

function traceTouchesKuru(node: CallTraceNode | undefined): boolean {
  if (!node) return false;

  const to = node.to?.toLowerCase();
  if (to && kuruAddressSet.has(to)) {
    return true;
  }

  for (const call of node.calls ?? []) {
    if (traceTouchesKuru(call)) {
      return true;
    }
  }

  return false;
}

export async function scanKuruWindow(
  fromBlock: number,
  toBlock: number
): Promise<KuruWindowScanResult> {
  const blockNums = Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index);
  const traceBlocks = new Set<number>();
  const txBlocks = new Set<number>();
  const timestamps = new Map<number, number>();

  const blocks = await getBlocksWithTransactions(blockNums);

  for (let index = 0; index < blockNums.length; index++) {
    const blockNum = blockNums[index];
    const block = blocks[index];
    if (!block) continue;

    if (block.timestamp) {
      timestamps.set(blockNum, parseInt(block.timestamp, 16));
    }

    for (const tx of block.transactions ?? []) {
      const to = tx.to?.toLowerCase();
      if (to && kuruAddressSet.has(to)) {
        txBlocks.add(blockNum);
        break;
      }
    }
  }

  const traceCandidateBlocks = blockNums.filter((blockNum) => !txBlocks.has(blockNum));
  const traces = await getBlockTraces(traceCandidateBlocks);

  for (let index = 0; index < traceCandidateBlocks.length; index++) {
    const blockNum = traceCandidateBlocks[index];
    const blockTraces = traces[index];
    if (!blockTraces) continue;

    for (const entry of blockTraces) {
      if (traceTouchesKuru(entry.result)) {
        traceBlocks.add(blockNum);
        break;
      }
    }
  }

  return { traceBlocks, txBlocks, timestamps };
}
