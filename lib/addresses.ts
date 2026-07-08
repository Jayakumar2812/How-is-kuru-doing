import addressesData from "@/kuru_addresses.json";

const ROLE_SUFFIXES = ["Impl", "Operator", "BackrunOperator", "FastlaneEntryPoint"] as const;
const ACTIVE_VAULT_ROLES = ["Operator", "Market", "Vault", "Impl"] as const;

function stripRoleSuffix(rest: string, roles: readonly string[]): string {
  for (const role of roles) {
    const suffix = `-${role}`;
    if (rest.endsWith(suffix)) {
      return rest.slice(0, -suffix.length);
    }
  }
  return rest;
}

function marketGroupKey(contractName: string): string | null {
  if (contractName.startsWith("Market-")) {
    const rest = stripRoleSuffix(contractName.slice("Market-".length), ROLE_SUFFIXES);
    return rest.replace(/-/g, "/");
  }
  if (contractName.startsWith("ActiveVault-")) {
    const rest = stripRoleSuffix(contractName.slice("ActiveVault-".length), ACTIVE_VAULT_ROLES);
    return `ActiveVault/${rest.replace(/-/g, "/")}`;
  }
  return null;
}

function isPrimaryMarketContract(contractName: string): boolean {
  return (
    contractName.startsWith("Market-") &&
    !ROLE_SUFFIXES.some((role) => contractName.endsWith(`-${role}`))
  );
}

export function loadKuruAddresses(): string[] {
  const addrs: string[] = [];
  const seen = new Set<string>();

  for (const proto of addressesData.protocols ?? []) {
    if (proto.name !== "Kuru") continue;

    for (const [, addr] of Object.entries(proto.contracts ?? {})) {
      const a = String(addr).trim().toLowerCase();
      if (!a.startsWith("0x") || a.length !== 42) {
        throw new Error(`invalid address: ${addr}`);
      }
      if (!seen.has(a)) {
        addrs.push(a);
        seen.add(a);
      }
    }
  }

  if (addrs.length === 0) {
    throw new Error("no Kuru contracts in kuru_addresses.json");
  }

  return addrs;
}

export const kuruAddresses = loadKuruAddresses();
export const kuruAddressSet = new Set(kuruAddresses);
