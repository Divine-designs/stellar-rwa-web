/**
 * Shared domain types. These mirror the Soroban contract data structures
 * (see stellar-rwa-contracts), translated into JS-friendly shapes:
 *   - i128 amounts / valuations  -> bigint
 *   - u64 ids                    -> bigint
 *   - u32 ledger sequences       -> number
 */

export type Network = "testnet" | "mainnet";

/**
 * The asset classes the platform supports. This list must mirror the registry
 * contract's `VALID_ASSET_TYPES` (stellar-rwa-contracts, contracts/registry):
 * a type the registry accepts but this list lacks is second-class in the UI.
 * `AssetType` is derived from it so the union and the list cannot drift.
 */
export const ASSET_TYPES = [
  "real_estate",
  "invoice",
  "commodity",
  "bond",
  "equity",
  "fund",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  real_estate: "Real Estate",
  invoice: "Invoice",
  commodity: "Commodity",
  bond: "Bond",
  equity: "Equity",
  fund: "Fund",
};

/** A registered asset, as returned by the registry contract's `AssetEntry`. */
export interface AssetEntry {
  id: bigint;
  tokenContract: string;
  issuer: string;
  name: string;
  assetType: string;
  /** Valuation in USD cents. */
  valuation: bigint;
  /** Ledger sequence at registration. */
  createdAt: number;
  active: boolean;
}

/** On-chain metadata from the asset-token contract's `AssetMetadata`. */
export interface AssetMetadata {
  name: string;
  symbol: string;
  assetType: string;
  totalSupply: bigint;
  decimals: number;
  admin: string;
  complianceContract: string;
  assetDescription: string;
  /** Valuation in USD cents. */
  valuation: bigint;
  paused: boolean;
}

/** Registry entry joined with its token metadata for detail views. */
export interface AssetDetail extends AssetEntry {
  metadata: AssetMetadata;
}

export type ComplianceStatus =
  | "Approved"
  | "Pending"
  | "Rejected"
  | "Suspended";

/** A KYC record from the compliance contract. */
export interface KycRecord {
  address: string;
  status: ComplianceStatus;
  /** ISO country code, e.g. "US", "KE", "DE". */
  jurisdiction: string;
  /** Ledger sequence at which the record was verified. */
  verifiedAt: number;
  /** Ledger sequence at which approval expires; 0 = never. */
  expiresAt: number;
}

/** A dividend distribution from the dividend contract. */
export interface Distribution {
  id: bigint;
  assetToken: string;
  paymentToken: string;
  totalAmount: bigint;
  distributed: bigint;
  createdAt: number;
  completed: boolean;
  /** Claim deadline ledger; 0 or undefined means no deadline. */
  claimDeadline?: number;
}

/** Result of submitting an on-chain transaction. */
export interface TxResult {
  hash: string;
  /** scValToNative-decoded return value, when the method returns one. */
  returnValue?: unknown;
  /** Estimated network fee in stroops from the simulation, when available. */
  estimatedFee?: bigint;
}

/** Phases surfaced to the user while a transaction is in flight. */
export type TxPhase =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "confirming"
  | "success"
  | "timeout"
  | "error";

/** Error type for transaction errors. */
export type TxErrorType = "generic" | "auth" | "locked-wallet" | "timeout";

/** Telemetry callbacks for transaction lifecycle events. */
export interface TxTelemetry {
  onPhase?: (phase: TxPhase, detail?: string) => void;
  onSuccess?: (hash: string, result: TxResult) => void;
  /** Called on transaction error with a typed classification of what went wrong. */
  onError?: (error: string, errorType: TxErrorType) => void;
}
