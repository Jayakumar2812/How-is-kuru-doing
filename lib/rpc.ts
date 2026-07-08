import "server-only";

import { rpcFetch, traceRpcFetch } from "@/lib/rpc-queue";

export const GET_LOGS_MAX_BLOCK_RANGE = 100;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RPC_BATCH_SIZE = parsePositiveInt(process.env.RPC_BATCH_SIZE, 20);
const TRACE_BATCH_SIZE = parsePositiveInt(process.env.RPC_TRACE_BATCH_SIZE, 4);
const LOGS_CHUNK_CONCURRENCY = parsePositiveInt(process.env.RPC_LOGS_CONCURRENCY, 4);

function normalizeRpcUrl(rpcUrl: string, envName: string): string {
  const url = new URL(rpcUrl);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new Error(`${envName} must use https for remote RPC endpoints`);
  }

  return url.toString();
}

function getRpcUrl(): string {
  const rpcUrl = process.env.MONAD_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new Error("MONAD_RPC_URL is not configured");
  }

  return normalizeRpcUrl(rpcUrl, "MONAD_RPC_URL");
}

function getTraceRpcUrl(): string {
  const rpcUrl = process.env.MONAD_TRACE_RPC_URL?.trim() || process.env.MONAD_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new Error("MONAD_TRACE_RPC_URL or MONAD_RPC_URL is not configured");
  }

  return normalizeRpcUrl(rpcUrl, "MONAD_TRACE_RPC_URL");
}

interface RpcErrorBody {
  error?: { message: string };
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const resp = await rpcFetch(getRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    cache: "no-store",
  });

  if (!resp.ok) {
    throw new Error(`RPC HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as { result?: T } & RpcErrorBody;
  if (body.error) {
    throw new Error(body.error.message);
  }

  return body.result as T;
}

async function rpcBatch<T>(
  calls: Array<{ method: string; params: unknown[] }>,
  rpcUrl = getRpcUrl(),
  fetcher: (url: string, init: RequestInit) => Promise<Response> = rpcFetch
): Promise<Array<T | null>> {
  if (calls.length === 0) return [];

  const resp = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      calls.map((call, index) => ({
        jsonrpc: "2.0",
        method: call.method,
        params: call.params,
        id: index + 1,
      }))
    ),
    cache: "no-store",
  });

  if (!resp.ok) {
    throw new Error(`RPC HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as Array<{ id: number; result?: T } & RpcErrorBody>;
  const sorted = [...body].sort((a, b) => a.id - b.id);
  return sorted.map((entry) => (entry.error ? null : (entry.result as T)));
}

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

export interface RpcTransaction {
  to: string | null;
}

export interface RpcBlockFull {
  timestamp: string;
  transactions: RpcTransaction[];
}

export interface CallTraceNode {
  to?: string;
  calls?: CallTraceNode[];
}

export interface TxTraceEntry {
  result?: CallTraceNode;
}

interface RpcBlockHeader {
  timestamp: string;
}

export async function getLogs(filter: {
  fromBlock: number;
  toBlock: number;
  address: string | string[];
  topics?: (string | string[] | null)[];
}): Promise<RpcLog[]> {
  return rpcCall<RpcLog[]>("eth_getLogs", [
    {
      fromBlock: toHex(filter.fromBlock),
      toBlock: toHex(filter.toBlock),
      address: filter.address,
      topics: filter.topics,
    },
  ]);
}

export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });

  await Promise.all(runners);
}

export async function getLogsChunked(
  fromBlock: number,
  toBlock: number,
  filter: {
    address: string | string[];
    topics?: (string | string[] | null)[];
  }
): Promise<RpcLog[]> {
  const chunkSize = GET_LOGS_MAX_BLOCK_RANGE;
  const ranges: Array<{ fromBlock: number; toBlock: number }> = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    ranges.push({
      fromBlock: start,
      toBlock: Math.min(start + chunkSize - 1, toBlock),
    });
  }

  const chunks: RpcLog[][] = ranges.map(() => []);
  const jobs = ranges.map((range, index) => ({ range, index }));
  await runPool(jobs, LOGS_CHUNK_CONCURRENCY, async ({ range, index }) => {
    chunks[index] = await getLogs({ ...filter, ...range });
  });

  return chunks.flat();
}

export async function getBlocksWithTransactions(blockNums: number[]): Promise<Array<RpcBlockFull | null>> {
  const results: Array<RpcBlockFull | null> = [];

  for (let start = 0; start < blockNums.length; start += RPC_BATCH_SIZE) {
    const slice = blockNums.slice(start, start + RPC_BATCH_SIZE);
    const batch = await rpcBatch<RpcBlockFull | null>(
      slice.map((blockNum) => ({
        method: "eth_getBlockByNumber",
        params: [toHex(blockNum), true],
      }))
    );
    results.push(...batch);
  }

  return results;
}

export async function getBlockTraces(blockNums: number[]): Promise<Array<TxTraceEntry[] | null>> {
  const results: Array<TxTraceEntry[] | null> = [];

  for (let start = 0; start < blockNums.length; start += TRACE_BATCH_SIZE) {
    const slice = blockNums.slice(start, start + TRACE_BATCH_SIZE);
    const batch = await rpcBatch<TxTraceEntry[] | null>(
      slice.map((blockNum) => ({
        method: "debug_traceBlockByNumber",
        params: [toHex(blockNum), { tracer: "callTracer" }],
      })),
      getTraceRpcUrl(),
      traceRpcFetch
    );
    results.push(...batch);
  }

  return results;
}

export async function getLatestBlock(): Promise<number> {
  const hex = await rpcCall<string>("eth_blockNumber", []);
  return parseInt(hex, 16);
}

export async function getBlockTimestamp(blockNum: number): Promise<number> {
  const block = await rpcCall<RpcBlockHeader | null>("eth_getBlockByNumber", [toHex(blockNum), false]);
  if (!block) {
    throw new Error(`block ${blockNum} not found`);
  }
  return parseInt(block.timestamp, 16);
}

export async function getBlockTimestamps(
  fromBlock: number,
  toBlock: number
): Promise<Map<number, number>> {
  const timestamps = new Map<number, number>();
  const blockNums = Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index);
  const blocks = await getBlocksWithTransactions(blockNums);

  for (let index = 0; index < blockNums.length; index++) {
    const block = blocks[index];
    if (block?.timestamp) {
      timestamps.set(blockNums[index], parseInt(block.timestamp, 16));
    }
  }

  return timestamps;
}

export async function getBlockTimestampOptional(blockNum: number): Promise<number | null> {
  const block = await rpcCall<RpcBlockHeader | null>("eth_getBlockByNumber", [toHex(blockNum), false]);
  if (!block) return null;
  return parseInt(block.timestamp, 16);
}

export async function findBlockAtOrAfter(targetTs: number, latestBlock: number): Promise<number | null> {
  let lo = 1;
  let hi = latestBlock;
  let res: number | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await getBlockTimestampOptional(mid);
    if (ts === null) {
      lo = mid + 1;
      continue;
    }
    if (ts < targetTs) {
      lo = mid + 1;
    } else {
      res = mid;
      hi = mid - 1;
    }
  }

  return res;
}

export async function findBlockAtOrBefore(
  targetTs: number,
  latestBlock: number,
  loBound = 0
): Promise<number | null> {
  let lo = Math.max(0, loBound);
  let hi = latestBlock;
  let res: number | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await getBlockTimestampOptional(mid);
    if (ts === null) {
      lo = mid + 1;
      continue;
    }
    if (ts > targetTs) {
      hi = mid - 1;
    } else {
      res = mid;
      lo = mid + 1;
    }
  }

  return res;
}

export async function resolveUtcDayToBlocks(
  startTs: number,
  endTs: number
): Promise<{ fromBlock: number; toBlock: number }> {
  const latest = await getLatestBlock();
  const fromBlock = await findBlockAtOrAfter(startTs, latest);
  if (fromBlock === null) {
    throw new Error("could not resolve start block for UTC window");
  }
  const toBlock = await findBlockAtOrBefore(endTs, latest, fromBlock);
  if (toBlock === null) {
    throw new Error("could not resolve end block for UTC window");
  }
  return { fromBlock, toBlock };
}

function toHex(n: number): string {
  return `0x${n.toString(16)}`;
}
