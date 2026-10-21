"use client";

import { useState, useRef } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import type { AssetDetail } from "@/types";
import { compliance } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { useAllowlist } from "@/hooks/useCompliance";
import { useWallet } from "@/hooks/useWallet";
import { getLatestLedger } from "@/lib/stellar";
import { ActionCard } from "@/components/issuer/ActionCard";
import { ComplianceBadge } from "@/components/compliance/ComplianceBadge";
import { TxProgress } from "@/components/ui/TxProgress";
import { Spinner } from "@/components/ui/Spinner";
import { ErrorState } from "@/components/ui/ErrorState";
import { truncateAddress } from "@/lib/format";
import {
  isValidJurisdiction,
  normalizeJurisdiction,
  JURISDICTION_ERROR,
  JURISDICTION_INPUT_MAX_LENGTH,
} from "@/lib/validation";
import { CopyButton } from "@/components/ui/CopyButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { explorerAddressUrl } from "@/lib/stellar";

interface CompliancePanelProps {
  asset: AssetDetail;
  onChanged?: () => void;
  isAdmin?: boolean;
}

/** KYC allowlist management: add/suspend/remove addresses, block/unblock jurisdictions. */
export function CompliancePanel({ asset, onChanged, isAdmin = true }: CompliancePanelProps) {
  const complianceId = asset.metadata.complianceContract;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-base-100/50">
        <strong>Required role:</strong> compliance contract <code className="font-mono text-base-100/60">admin</code>
      </div>
      <AddToAllowlistCard
        complianceId={complianceId}
        {...(onChanged !== undefined ? { onChanged } : {})}
        isAdmin={isAdmin}
      />
      <AllowlistManageCard
        complianceId={complianceId}
        {...(onChanged !== undefined ? { onChanged } : {})}
        isAdmin={isAdmin}
      />
      <JurisdictionCard
        complianceId={complianceId}
        {...(onChanged !== undefined ? { onChanged } : {})}
        isAdmin={isAdmin}
      />
    </div>
  );
}

// ---- Add to allowlist ----

function AddToAllowlistCard({
  complianceId,
  onChanged,
  isAdmin = true,
}: {
  complianceId: string;
  onChanged?: () => void;
  isAdmin?: boolean;
}) {
  const tx = useTx();
  const { network } = useWallet();
  const [address, setAddress] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const addr = address.trim();
    if (!StrKey.isValidEd25519PublicKey(addr) && !StrKey.isValidContract(addr)) {
      setFormError("Enter a valid Stellar address (G… or C…).");
      return;
    }
    if (!isValidJurisdiction(jurisdiction)) {
      setFormError(JURISDICTION_ERROR);
      return;
    }
    const jur = normalizeJurisdiction(jurisdiction);
    let expiry = 0;
    if (expiresAt.trim()) {
      expiry = parseInt(expiresAt.trim(), 10);
      if (isNaN(expiry) || expiry < 0) {
        setFormError("Expiry ledger must be a non-negative integer (0 = never expires).");
        return;
      }
      // #322: Reject ledger numbers that are already in the past. A KYC record
      // with an expiry <= the current ledger is dead on arrival — the contract
      // will treat it as expired immediately, so warn the issuer here instead
      // of silently creating a useless record.
      if (expiry > 0) {
        try {
          const latestLedger = await getLatestLedger(network);
          if (expiry <= latestLedger) {
            setFormError(
              `Ledger ${expiry} is already in the past (current ledger: ${latestLedger}). Enter a future ledger number or 0 for no expiry.`,
            );
            return;
          }
        } catch {
          // If the ledger fetch fails (e.g., offline), allow the submit to
          // proceed so the user isn't blocked — the contract will enforce its
          // own rules on submission.
        }
      }
    }

    const res = await tx.run((ctx) =>
      compliance.addToAllowlist(ctx, complianceId, addr, jur, expiry),
    );
    if (res) {
      setAddress("");
      setJurisdiction("");
      setExpiresAt("");
      onChanged?.();
    }
  }

  return (
    <ActionCard
      title="Approve address"
      description="Add an address to the KYC allowlist, granting it the right to hold and transfer this asset."
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" strokeLinecap="round" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6M22 11h-6" strokeLinecap="round" />
        </svg>
      }
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label htmlFor="kyc-address" className="label">Address</label>
          <input
            id="kyc-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="G… or C…"
            disabled={tx.pending || !isAdmin}
            className="input font-mono text-xs"
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="kyc-jurisdiction" className="label">Jurisdiction</label>
            <input
              id="kyc-jurisdiction"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value.toUpperCase())}
              placeholder="US"
              maxLength={JURISDICTION_INPUT_MAX_LENGTH}
              disabled={tx.pending || !isAdmin}
              className="input uppercase"
            />
          </div>
          <div>
            <label htmlFor="kyc-expires" className="label">Expires at ledger</label>
            <input
              id="kyc-expires"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              placeholder="0 = never"
              inputMode="numeric"
              disabled={tx.pending || !isAdmin}
              className="input"
            />
          </div>
        </div>

        {formError && <p className="text-xs text-red-400">{formError}</p>}

        {tx.phase === "idle" ? (
          <button
            type="submit"
            disabled={tx.pending || !isAdmin}
            className="btn-primary"
            title={!isAdmin ? "Only the asset admin can manage the allowlist" : ""}
          >
            Approve address
          </button>
        ) : (
          <TxProgress
            phase={tx.phase}
            hash={tx.hash}
            error={tx.error}
            errorType={tx.errorType}
            onDismiss={tx.reset}
            onRetry={tx.retry}
            retryable={tx.retryable}
            successMessage="Address approved on the KYC allowlist."
          />
        )}
      </form>
    </ActionCard>
  );
}

// ---- Manage existing allowlist entries ----

function AllowlistManageCard({
  complianceId,
  onChanged,
  isAdmin = true,
}: {
  complianceId: string;
  onChanged?: () => void;
  isAdmin?: boolean;
}) {
  const { data, loading, error, refetch } = useAllowlist(complianceId);
  const records = data ?? [];

  // #320: Serialize allowlist mutations across all rows so the issuer cannot
  // fire concurrent wallet-signing prompts by rapidly clicking buttons on
  // different rows. A ref (not state) is used so incrementing/decrementing
  // does not cause a re-render loop; AllowlistRow reads it at click time.
  const activeMutationsRef = useRef(0);

  const handleChanged = () => {
    refetch();
    onChanged?.();
  };

  return (
    <ActionCard
      title="Manage allowlist"
      description="Suspend or remove existing KYC-approved addresses. Suspended holders retain their record but lose transfer rights."
      accent="bg-gold-500/10 text-gold-400"
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeLinecap="round" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 11H17M20 8v6" strokeLinecap="round" />
        </svg>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-base-100/55">
          <Spinner size={14} /> Loading allowlist…
        </div>
      ) : error ? (
        <ErrorState
          title="Couldn't load allowlist"
          message={error}
          onRetry={refetch}
          className="py-6"
        />
      ) : records.length === 0 ? (
        <p className="py-2 text-sm text-base-100/55">No addresses on the allowlist yet.</p>
      ) : (
        <ul className="divide-y divide-white/5 max-h-80 overflow-y-auto pr-1">
          {records.map((r) => (
            <AllowlistRow
              key={r.address}
              record={r}
              complianceId={complianceId}
              onChanged={handleChanged}
              activeMutationsRef={activeMutationsRef}
              isAdmin={isAdmin}
            />
          ))}
        </ul>
      )}
    </ActionCard>
  );
}

function AllowlistRow({
  record,
  complianceId,
  onChanged,
  activeMutationsRef,
  isAdmin = true,
}: {
  record: { address: string; status: string; jurisdiction: string; expiresAt: number };
  complianceId: string;
  onChanged?: () => void;
  /** #320: Shared ref counting in-flight mutations across all rows in the list.
   *  Prevents burst concurrent wallet-signing prompts when the issuer rapidly
   *  clicks buttons on different rows. */
  activeMutationsRef: React.MutableRefObject<number>;
  isAdmin?: boolean;
}) {
  const suspendTx = useTx();
  const removeTx = useTx();
  const { network } = useWallet();
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  const isSuspended = record.status === "Suspended";
  // Disable this row's buttons if THIS row has a pending tx OR if any other
  // row in the list is already signing/submitting.
  const isPending = suspendTx.pending || removeTx.pending;

  async function runWithSerialize(fn: () => Promise<unknown>) {
    // Block if any mutation across all rows is already in flight.
    if (activeMutationsRef.current > 0) return;
    activeMutationsRef.current += 1;
    try {
      await fn();
    } finally {
      activeMutationsRef.current -= 1;
    }
  }

  async function doRemove() {
    setRemoveConfirmOpen(false);
    await runWithSerialize(() =>
      removeTx
        .run((ctx) => compliance.remove(ctx, complianceId, record.address))
        .then((r) => r && onChanged?.()),
    );
  }

  return (
    <>
      <ConfirmDialog
        open={removeConfirmOpen}
        title="Remove address from allowlist?"
        description={`This will remove ${record.address} from the allowlist immediately, preventing it from holding, sending, or receiving this asset. You can re-approve it later if needed.`}
        confirmLabel="Remove address"
        onConfirm={doRemove}
        onCancel={() => setRemoveConfirmOpen(false)}
      />

      <li className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <a
              href={explorerAddressUrl(network ?? "testnet", record.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-base-100/80 hover:text-brand-300"
            >
              {truncateAddress(record.address, 6, 6)}
            </a>
            <CopyButton value={record.address} />
            <ComplianceBadge status={record.status as never} />
            <span className="text-[10px] text-base-100/55">{record.jurisdiction}</span>
            <span className="text-[10px] text-base-100/55">
              {record.expiresAt === 0 ? "Never expires" : `Expires at ledger ${record.expiresAt}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isSuspended && (
              <button
                onClick={() =>
                  runWithSerialize(() =>
                    suspendTx
                      .run((ctx) => compliance.suspend(ctx, complianceId, record.address))
                      .then((r) => r && onChanged?.()),
                  )
                }
                disabled={isPending || !isAdmin}
                className="btn-ghost py-1 text-xs text-amber-300 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                title={!isAdmin ? "Only the asset admin can modify allowlist" : ""}
              >
                Suspend
              </button>
            )}
            {isSuspended && (
              <button
                onClick={() =>
                  runWithSerialize(() =>
                    suspendTx
                      .run((ctx) =>
                        compliance.addToAllowlist(
                          ctx,
                          complianceId,
                          record.address,
                          record.jurisdiction,
                          record.expiresAt,
                        ),
                      )
                      .then((r) => r && onChanged?.()),
                  )
                }
                disabled={isPending || !isAdmin}
                className="btn-ghost py-1 text-xs text-brand-300 hover:bg-brand-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                title={!isAdmin ? "Only the asset admin can modify allowlist" : ""}
              >
                Re-approve
              </button>
            )}
            <button
              onClick={() => setRemoveConfirmOpen(true)}
              disabled={isPending || !isAdmin}
              className="btn-ghost py-1 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
              title={!isAdmin ? "Only the asset admin can modify allowlist" : ""}
            >
              Remove
            </button>
          </div>
        </div>
        {/* Show inline TX progress if either action is in flight */}
        {suspendTx.phase !== "idle" && (
          <div className="mt-2">
            <TxProgress
              phase={suspendTx.phase}
              hash={suspendTx.hash}
              error={suspendTx.error}
              errorType={suspendTx.errorType}
              onDismiss={suspendTx.reset}
              onRetry={suspendTx.retry}
              retryable={suspendTx.retryable}
              successMessage="Status updated."
            />
          </div>
        )}
        {removeTx.phase !== "idle" && (
          <div className="mt-2">
            <TxProgress
              phase={removeTx.phase}
              hash={removeTx.hash}
              error={removeTx.error}
              errorType={removeTx.errorType}
              onDismiss={removeTx.reset}
              onRetry={removeTx.retry}
              retryable={removeTx.retryable}
              successMessage="Address removed from allowlist."
            />
          </div>
        )}
      </li>
    </>
  );
}

// ---- Jurisdiction block / unblock ----

function JurisdictionCard({
  complianceId,
  onChanged,
  isAdmin = true,
}: {
  complianceId: string;
  onChanged?: () => void;
  isAdmin?: boolean;
}) {
  const blockTx = useTx();
  const unblockTx = useTx();
  const [blockJur, setBlockJur] = useState("");
  const [unblockJur, setUnblockJur] = useState("");
  const [blockError, setBlockError] = useState<string | null>(null);
  const [unblockError, setUnblockError] = useState<string | null>(null);

  function validateJur(val: string): string | null {
    return isValidJurisdiction(val) ? null : JURISDICTION_ERROR;
  }

  // Either form being in-flight locks out the other to prevent racing a
  // block and an unblock against the same jurisdiction before either confirms.
  const eitherPending = blockTx.pending || unblockTx.pending;

  async function onBlock(e: React.FormEvent) {
    e.preventDefault();
    if (eitherPending) return;
    const err = validateJur(blockJur);
    if (err) { setBlockError(err); return; }
    setBlockError(null);
    const res = await blockTx.run((ctx) =>
      compliance.blockJurisdiction(ctx, complianceId, normalizeJurisdiction(blockJur)),
    );
    if (res) { setBlockJur(""); onChanged?.(); }
  }

  async function onUnblock(e: React.FormEvent) {
    e.preventDefault();
    if (eitherPending) return;
    const err = validateJur(unblockJur);
    if (err) { setUnblockError(err); return; }
    setUnblockError(null);
    const res = await unblockTx.run((ctx) =>
      compliance.unblockJurisdiction(ctx, complianceId, normalizeJurisdiction(unblockJur)),
    );
    if (res) { setUnblockJur(""); onChanged?.(); }
  }

  return (
    <ActionCard
      title="Jurisdiction controls"
      description="Block or unblock entire jurisdictions. Addresses from blocked jurisdictions fail the compliance gate even if individually approved."
      accent="bg-red-500/10 text-red-400"
      icon={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 2a14.5 14.5 0 0 1 0 20M12 2a14.5 14.5 0 0 0 0 20M2 12h20" strokeLinecap="round" />
        </svg>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Block */}
        <form onSubmit={onBlock} className="space-y-2">
          <label htmlFor="block-jur" className="label">Block jurisdiction</label>
          <div className="flex gap-2">
            <input
              id="block-jur"
              value={blockJur}
              onChange={(e) => setBlockJur(e.target.value.toUpperCase())}
              placeholder="e.g. KP"
              maxLength={JURISDICTION_INPUT_MAX_LENGTH}
              disabled={eitherPending || !isAdmin}
              className="input flex-1 uppercase"
            />
            <button
              type="submit"
              disabled={eitherPending || !isAdmin}
              className="btn-secondary shrink-0"
              title={!isAdmin ? "Only the asset admin can block jurisdictions" : ""}
            >
              Block
            </button>
          </div>
          {blockError && <p className="text-xs text-red-400">{blockError}</p>}
          {blockTx.phase !== "idle" && (
            <TxProgress
              phase={blockTx.phase}
              hash={blockTx.hash}
              error={blockTx.error}
              errorType={blockTx.errorType}
              onDismiss={blockTx.reset}
              onRetry={blockTx.retry}
              retryable={blockTx.retryable}
              successMessage="Jurisdiction blocked."
            />
          )}
        </form>

        {/* Unblock */}
        <form onSubmit={onUnblock} className="space-y-2">
          <label htmlFor="unblock-jur" className="label">Unblock jurisdiction</label>
          <div className="flex gap-2">
            <input
              id="unblock-jur"
              value={unblockJur}
              onChange={(e) => setUnblockJur(e.target.value.toUpperCase())}
              placeholder="e.g. US"
              maxLength={JURISDICTION_INPUT_MAX_LENGTH}
              disabled={eitherPending || !isAdmin}
              className="input flex-1 uppercase"
            />
            <button
              type="submit"
              disabled={eitherPending || !isAdmin}
              className="btn-secondary shrink-0"
              title={!isAdmin ? "Only the asset admin can unblock jurisdictions" : ""}
            >
              Unblock
            </button>
          </div>
          {unblockError && <p className="text-xs text-red-400">{unblockError}</p>}
          {unblockTx.phase !== "idle" && (
            <TxProgress
              phase={unblockTx.phase}
              hash={unblockTx.hash}
              error={unblockTx.error}
              errorType={unblockTx.errorType}
              onDismiss={unblockTx.reset}
              onRetry={unblockTx.retry}
              retryable={unblockTx.retryable}
              successMessage="Jurisdiction unblocked."
            />
          )}
        </form>
      </div>
    </ActionCard>
  );
}
