"use client";

import { useEffect, useState } from "react";
import { useHolders, type Holder } from "@/hooks/useHolders";
import { formatTokenAmount, holderSharePercentages, truncateAddress } from "@/lib/format";
import { useWallet } from "@/hooks/useWallet";
import { explorerAddressUrl } from "@/lib/stellar";
import { CopyButton } from "@/components/ui/CopyButton";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import type { AssetDetail, Network } from "@/types";

const ROWS_PER_PAGE = 25;
const VIRTUALIZE_THRESHOLD = 50;

interface HolderListProps {
  asset: AssetDetail;
  /** Notified with the holder count once resolved (feeds AssetStats). */
  onCount?: (count: number) => void;
  /** Bump to force a refetch (e.g. after a confirmed transfer). */
  refreshKey?: number;
}

export function HolderList({ asset, onCount, refreshKey }: HolderListProps) {
  const { metadata } = asset;
  const { address, network } = useWallet();
  const { data, loading, error, refetch } = useHolders(
    metadata.complianceContract,
    asset.tokenContract,
    refreshKey,
    // #532: the API's holder endpoint is keyed on the registry asset id.
    asset.id,
  );
  const [displayCount, setDisplayCount] = useState(ROWS_PER_PAGE);
  // Reset the page size during render rather than in an effect when the
  // asset changes, per React's guidance on adjusting state from props
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevTokenContract, setPrevTokenContract] = useState(asset.tokenContract);
  if (asset.tokenContract !== prevTokenContract) {
    setPrevTokenContract(asset.tokenContract);
    setDisplayCount(ROWS_PER_PAGE);
  }

  const holders = data ?? [];
  const needsPagination = holders.length > VIRTUALIZE_THRESHOLD;
  const displayedHolders = needsPagination ? holders.slice(0, displayCount) : holders;
  const hasMore = displayCount < holders.length;

  useEffect(() => {
    if (data && onCount) onCount(data.length);
  }, [data, onCount]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-base-100/55">
        <Spinner size={16} /> Loading holders…
      </div>
    );
  }
  if (error) {
    return (
      <ErrorState
        title="Couldn't load holders"
        message={error}
        onRetry={refetch}
        className="py-8"
      />
    );
  }
  if (holders.length === 0) {
    return (
      <EmptyState
        title="No holders yet"
        description="Once the issuer distributes this asset to approved addresses, holders appear here."
        className="py-10"
      />
    );
  }

  const shares = holderSharePercentages(
    holders.map((holder) => holder.balance),
    metadata.totalSupply,
  );

  // Address / balance / share is genuinely tabular data, so a real table gives
  // assistive tech column headers instead of a bare list of rows.
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-full sm:w-full text-left text-sm">
          <caption className="sr-only">Token holders with balance and share of supply{needsPagination ? ` (showing ${displayedHolders.length} of ${holders.length})` : ''}</caption>
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wide text-base-100/55">
              <th scope="col" className="py-2 pr-2 sm:pr-3 font-medium">Address</th>
              <th scope="col" className="py-2 pr-2 sm:pr-3 text-right font-medium">Balance</th>
              <th scope="col" className="py-2 pr-2 sm:pr-3 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {displayedHolders.map((h, index) => (
              <HolderRow
                key={h.address}
                holder={h}
                network={network}
                decimals={metadata.decimals}
                symbol={metadata.symbol}
                share={shares[index] ?? "0.00"}
                isYou={h.address === address}
              />
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => setDisplayCount((prev) => prev + ROWS_PER_PAGE)}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/5"
          >
            Show more holders ({displayedHolders.length} of {holders.length})
          </button>
        </div>
      )}
    </div>
  );
}

function HolderRow({
  holder,
  network,
  decimals,
  symbol,
  share,
  isYou,
}: {
  holder: Holder;
  network: Network;
  decimals: number;
  symbol: string;
  share: string;
  isYou: boolean;
}) {
  return (
    <tr>
      <th scope="row" className="py-3 pr-3 text-left font-normal">
        <div className="flex items-center gap-2">
          <a
            href={explorerAddressUrl(network ?? "testnet", holder.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-sm text-base-100/80 hover:text-brand-300"
          >
            {truncateAddress(holder.address, 6, 6)}
          </a>
          {isYou && (
            <span className="chip border border-brand-500/25 bg-brand-500/10 text-brand-300">You</span>
          )}
          <CopyButton value={holder.address} />
        </div>
      </th>
      <td className="py-3 pr-3 text-right text-sm font-semibold text-base-100">
        {formatTokenAmount(holder.balance, decimals)} {symbol}
      </td>
      <td className="py-3 text-right text-xs text-base-100/55">{share}%</td>
    </tr>
  );
}
