import { formatTokenAmount, getTokenMeta, USDC_ADDRESS } from "@/lib/tokens";
import type { TokenFlow } from "@/lib/types";
import { getLogsChunked } from "@/lib/rpc";

export const MARGIN_ACCOUNT = "0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5";

export const DEPOSIT_TOPIC0 =
  "0x5548c837ab068cf56a2c2479df0882a4922fd203edb7517321831d95078c5f62";
export const WITHDRAWAL_TOPIC0 =
  "0x2717ead6b9200dd235aad468c9809ea400fe33ac69b5bfaa6d3e90fc922b6398";

interface TokenAgg {
  inflowRaw: bigint;
  outflowRaw: bigint;
  depositCount: number;
  withdrawalCount: number;
}

function decodeMarginLogData(data: string): { token: string; amount: bigint } {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 192) {
    throw new Error("log data too short for MarginAccount event");
  }
  const token = `0x${hex.slice(88, 128)}`.toLowerCase();
  const amount = BigInt(`0x${hex.slice(128, 192)}`);
  return { token, amount };
}

function getTopic0(topics: string[] | undefined): string {
  const topic = topics?.[0];
  return topic ? topic.toLowerCase() : "";
}

async function collectMarginAggregates(
  fromBlock: number,
  toBlock: number
): Promise<Map<string, TokenAgg>> {
  const logs = await getLogsChunked(fromBlock, toBlock, {
    address: MARGIN_ACCOUNT,
    topics: [[DEPOSIT_TOPIC0, WITHDRAWAL_TOPIC0]],
  });

  const aggregates = new Map<string, TokenAgg>();

  for (const log of logs) {
    const blockNumber = parseInt(log.blockNumber, 16);
    if (!Number.isFinite(blockNumber) || blockNumber < fromBlock || blockNumber > toBlock) {
      continue;
    }
    if (!log.data) continue;

    let decoded: { token: string; amount: bigint };
    try {
      decoded = decodeMarginLogData(log.data);
    } catch {
      continue;
    }

    const topic0 = getTopic0(log.topics);
    const entry = aggregates.get(decoded.token) ?? {
      inflowRaw: BigInt(0),
      outflowRaw: BigInt(0),
      depositCount: 0,
      withdrawalCount: 0,
    };

    if (topic0 === DEPOSIT_TOPIC0) {
      entry.inflowRaw += decoded.amount;
      entry.depositCount += 1;
    } else if (topic0 === WITHDRAWAL_TOPIC0) {
      entry.outflowRaw += decoded.amount;
      entry.withdrawalCount += 1;
    } else {
      continue;
    }

    aggregates.set(decoded.token, entry);
  }

  return aggregates;
}

function toTokenFlow(address: string, agg: TokenAgg): TokenFlow {
  const meta = getTokenMeta(address);
  const netRaw = agg.inflowRaw - agg.outflowRaw;
  return {
    address,
    symbol: meta.symbol,
    decimals: meta.decimals,
    inflow: formatTokenAmount(agg.inflowRaw, meta.decimals),
    outflow: formatTokenAmount(agg.outflowRaw, meta.decimals),
    net: formatTokenAmount(netRaw, meta.decimals),
    depositCount: agg.depositCount,
    withdrawalCount: agg.withdrawalCount,
  };
}

export async function scanMarginFlows(fromBlock: number, toBlock: number): Promise<TokenFlow[]> {
  const aggregates = await collectMarginAggregates(fromBlock, toBlock);

  return [...aggregates.entries()]
    .map(([address, agg]) => ({ address, agg, flow: toTokenFlow(address, agg) }))
    .sort((a, b) => {
      const volA = a.agg.inflowRaw + a.agg.outflowRaw;
      const volB = b.agg.inflowRaw + b.agg.outflowRaw;
      if (volA === volB) return a.flow.symbol.localeCompare(b.flow.symbol);
      return volA > volB ? -1 : 1;
    })
    .map(({ flow }) => flow);
}

export { USDC_ADDRESS as DEFAULT_TOKEN };
