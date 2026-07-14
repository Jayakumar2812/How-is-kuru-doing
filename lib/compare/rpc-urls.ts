import "server-only";

function normalizeHttpsRpc(rpcUrl: string, envName: string): string {
  const url = new URL(rpcUrl);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new Error(`${envName} must use https for remote RPC endpoints`);
  }
  return url.toString();
}

export function getMonadRpcUrl(): string {
  const rpcUrl = process.env.MONAD_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("MONAD_RPC_URL is not configured");
  return normalizeHttpsRpc(rpcUrl, "MONAD_RPC_URL");
}

export function getSolanaRpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com"
  );
}

export function getKuruApiBase(): string | null {
  const base = process.env.KURU_DEPTH_API_BASE?.trim();
  return base || null;
}
