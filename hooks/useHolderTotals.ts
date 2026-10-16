"use client";

import { assetToken, compliance } from "@/lib/contracts";
import { api } from "@/lib/api";
import { useWallet } from "@/hooks/useWallet";
import { useAsync } from "@/hooks/useAsync";
import type { AssetEntry } from "@/types";

/**
 * Count the distinct KYC-approved addresses across a set of assets. Assets can
 * share a compliance contract, so we dedupe by compliance contract before
 * unioning the allowlists. Returns 0 for an empty set.
 * When the API is configured, reads the pre-aggregated holder count instead.
 */
export function useHolderTotals(assets: AssetEntry[] | null) {
  const { network } = useWallet();
  const key = assets ? assets.map((a) => a.id.toString()).join(",") : "";
  return useAsync<number>(
    async () => {
      if (!assets || assets.length === 0) return 0;

      const stats = await api.getStats();
      if (stats && stats.totalHolders !== null) return stats.totalHolders;

      const metas = await Promise.all(
        assets.map((a) => assetToken.getMetadata(network, a.tokenContract)),
      );
      const complianceContracts = Array.from(
        new Set(metas.map((m) => m.complianceContract)),
      );
      const lists = await Promise.all(
        complianceContracts.map((c) => compliance.getAllowlist(network, c)),
      );
      const unique = new Set<string>();
      for (const list of lists) for (const addr of list) unique.add(addr);
      return unique.size;
    },
    [key, network],
    assets !== null,
  );
}
