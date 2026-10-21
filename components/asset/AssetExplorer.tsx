"use client";

import { useMemo, useCallback, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAssets } from "@/hooks/useAssets";
import { AssetGrid } from "./AssetGrid";
import {
  AssetFilter,
  type FilterValue,
  type TypeFilter,
  type SortKey,
} from "./AssetFilter";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ASSET_TYPES, type AssetType } from "@/types";
import { DataFreshness } from "@/components/ui/DataFreshness";

const PAGE_SIZE = 9;

const VALID_SORT_KEYS: SortKey[] = ["valuation", "newest"];
const VALID_TYPE_FILTERS: TypeFilter[] = ["all", ...ASSET_TYPES];

function isValidSortKey(value: string): value is SortKey {
  return VALID_SORT_KEYS.includes(value as SortKey);
}

function isValidTypeFilter(value: string): value is TypeFilter {
  return VALID_TYPE_FILTERS.includes(value as TypeFilter);
}

/**
 * Client island powering /explore: loads all registered assets, applies the
 * type filter and sort, and paginates the results with numbered page controls.
 * Search, filter and page state are serialised into the URL (q, type, sort,
 * page) so filtered views can be linked and restored on refresh.
 */
const DEBOUNCE_DELAY_MS = 300;

export function AssetExplorer() {
  const { assets, loading, error, refetch, updatedAt } = useAssets();
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get("q") ?? "";

  const [pendingSearch, setPendingSearch] = useState(search);
  const [pendingFilter, setPendingFilter] = useState<FilterValue | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<NodeJS.Timeout | null>(null);
  const [filterTimeout, setFilterTimeout] = useState<NodeJS.Timeout | null>(null);

  // Derive filter and page from URL search params, falling back to defaults.
  const filter: FilterValue = useMemo(() => {
    const rawType = searchParams.get("type") ?? "all";
    const rawSort = searchParams.get("sort") ?? "valuation";
    return {
      type: isValidTypeFilter(rawType) ? rawType : "all",
      sort: isValidSortKey(rawSort) ? rawSort : "valuation",
    };
  }, [searchParams]);

  const page = useMemo(() => {
    const raw = searchParams.get("page");
    const parsed = raw ? parseInt(raw, 10) : 1;
    return isNaN(parsed) || parsed < 1 ? 1 : parsed;
  }, [searchParams]);

  const counts = useMemo(() => {
    // Seed one bucket per known type from ASSET_TYPES so a new type can't be
    // left out and make the per-type counts stop adding up to "all".
    const c = { all: assets.length } as Record<TypeFilter, number>;
    for (const t of ASSET_TYPES) c[t] = 0;
    for (const a of assets) {
      if (ASSET_TYPES.includes(a.assetType as AssetType)) {
        c[a.assetType as AssetType] += 1;
      }
    }
    return c;
  }, [assets]);

  const filtered = useMemo(() => {
    let list = assets;
    if (filter.type !== "all") {
      list = list.filter((a) => a.assetType === filter.type);
    }
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((asset) =>
        [
          asset.name,
          asset.id.toString(),
          asset.issuer,
          asset.tokenContract,
          asset.assetType,
        ].some((field) => field.toLowerCase().includes(term)),
      );
    }
    const sorted = [...list].sort((a, b) => {
      if (filter.sort === "valuation") {
        return a.valuation > b.valuation ? -1 : a.valuation < b.valuation ? 1 : 0;
      }
      return b.createdAt - a.createdAt;
    });
    return sorted;
  }, [assets, filter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  /** Build a new URL by merging changes into the current search params. */
  const buildUrl = useCallback(
    (updates: Partial<{ type: TypeFilter; sort: SortKey; page: number; q: string }>) => {
      const params = new URLSearchParams(searchParams.toString());
      if (updates.type !== undefined) {
        if (updates.type === "all") {
          params.delete("type");
        } else {
          params.set("type", updates.type);
        }
      }
      if (updates.sort !== undefined) {
        if (updates.sort === "valuation") {
          params.delete("sort");
        } else {
          params.set("sort", updates.sort);
        }
      }
      if (updates.page !== undefined) {
        if (updates.page <= 1) {
          params.delete("page");
        } else {
          params.set("page", String(updates.page));
        }
      }
      if (updates.q !== undefined) {
        const query = updates.q.trim();
        if (query) {
          params.set("q", query);
        } else {
          params.delete("q");
        }
      }
      const qs = params.toString();
      return qs ? `/explore?${qs}` : "/explore";
    },
    [searchParams],
  );

  const updateFilter = useCallback(
    (next: FilterValue) => {
      setPendingFilter(next);
      if (filterTimeout) clearTimeout(filterTimeout);
      const timer = setTimeout(() => {
        router.push(buildUrl({ type: next.type, sort: next.sort, page: 1 }));
      }, DEBOUNCE_DELAY_MS);
      setFilterTimeout(timer);
    },
    [router, buildUrl, filterTimeout],
  );

  const goToPage = useCallback(
    (p: number) => {
      router.push(buildUrl({ page: p }));
    },
    [router, buildUrl],
  );

  const updateSearch = useCallback(
    (next: string) => {
      setPendingSearch(next);
      if (searchTimeout) clearTimeout(searchTimeout);
      const timer = setTimeout(() => {
        router.replace(buildUrl({ q: next, page: 1 }), { scroll: false });
      }, DEBOUNCE_DELAY_MS);
      setSearchTimeout(timer);
    },
    [router, buildUrl, searchTimeout],
  );

  return (
    <div className="space-y-8">
      <AssetFilter
        value={filter}
        onChange={updateFilter}
        search={search}
        onSearchChange={updateSearch}
        counts={counts}
      />

      {loading ? (
        <AssetGrid assets={[]} loading skeletonCount={PAGE_SIZE} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} headingLevel={2} />
      ) : filtered.length === 0 ? (
        <EmptyState
          headingLevel={2}
          title={
            search.trim()
              ? "No assets found"
              : filter.type === "all"
                ? "No assets tokenized yet"
                : "No assets of this type"
          }
          description={
            search.trim()
              ? "Try a different search or clear the search field."
              : filter.type === "all"
                ? "Be the first to bring a real-world asset on-chain."
                : "Try a different asset class or clear the filter."
          }
        />
      ) : (
        <AssetGrid
          assets={visible}
          headingLevel={2}
          page={currentPage}
          totalPages={totalPages}
          total={filtered.length}
          onPageChange={goToPage}
        />
      )}
      {!loading && !error && <DataFreshness updatedAt={updatedAt} />}
    </div>
  );
}
