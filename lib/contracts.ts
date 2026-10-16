/**
 * Typed bindings for the four RWA contracts (registry, compliance,
 * asset-token, dividend). Read methods simulate; write methods build, sign and
 * submit. Raw scValToNative output (snake_case, bigint scalars) is normalised
 * into the camelCase domain types in `@/types`.
 */

import {
  arg,
  invokeContract,
  readContract,
  type Signer,
} from "@/lib/stellar";
import type {
  AssetEntry,
  AssetMetadata,
  ComplianceStatus,
  Distribution,
  KycRecord,
  Network,
  TxResult,
} from "@/types";

// ---- contract id resolution ----

interface ContractIds {
  registry: string;
  compliance: string;
  dividend: string;
}

const IDS: Record<Network, ContractIds> = {
  testnet: {
    registry:
      process.env.NEXT_PUBLIC_TESTNET_REGISTRY_ID ??
      "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
    compliance:
      process.env.NEXT_PUBLIC_TESTNET_COMPLIANCE_ID ??
      "CBUERYDM7DXTZLLKDBRJKUBPFJ7M4OSUN4T7XKUARU345RLXNAIQD2IU",
    dividend:
      process.env.NEXT_PUBLIC_TESTNET_DIVIDEND_ID ??
      "CAR4XY3CEBQWFOL27JEWFW34KXSIZA7RFKDQMEIV7ZU723RWY37I2SYX",
  },
  mainnet: {
    registry: process.env.NEXT_PUBLIC_MAINNET_REGISTRY_ID ?? "",
    compliance: process.env.NEXT_PUBLIC_MAINNET_COMPLIANCE_ID ?? "",
    dividend: process.env.NEXT_PUBLIC_MAINNET_DIVIDEND_ID ?? "",
  },
};

export function contractIds(network: Network): ContractIds {
  return IDS[network];
}

/** Context threaded through every write. `sign` is bound to the connected wallet. */
export interface WriteCtx {
  network: Network;
  source: string;
  sign: Signer;
  onPhase?: (phase: "building" | "signing" | "submitting" | "confirming") => void;
}

function write(
  ctx: WriteCtx,
  contractId: string,
  method: string,
  args: Parameters<typeof invokeContract>[4],
): Promise<TxResult> {
  return invokeContract(
    ctx.network,
    ctx.source,
    contractId,
    method,
    args,
    ctx.sign,
    ctx.onPhase,
  );
}

// ---- normalisers ----

type RawEntry = {
  id: bigint;
  token_contract: string;
  issuer: string;
  name: string;
  asset_type: string;
  valuation: bigint;
  created_at: number;
  active: boolean;
};

function toAssetEntry(r: RawEntry): AssetEntry {
  return {
    id: BigInt(r.id),
    tokenContract: r.token_contract,
    issuer: r.issuer,
    name: r.name,
    assetType: r.asset_type,
    valuation: BigInt(r.valuation),
    createdAt: Number(r.created_at),
    active: r.active,
  };
}

type RawMetadata = {
  name: string;
  symbol: string;
  asset_type: string;
  total_supply: bigint;
  decimals: number;
  admin: string;
  compliance_contract: string;
  asset_description: string;
  valuation: bigint;
  paused: boolean;
};

function toMetadata(r: RawMetadata): AssetMetadata {
  return {
    name: r.name,
    symbol: r.symbol,
    assetType: r.asset_type,
    totalSupply: BigInt(r.total_supply),
    decimals: Number(r.decimals),
    admin: r.admin,
    complianceContract: r.compliance_contract,
    assetDescription: r.asset_description,
    valuation: BigInt(r.valuation),
    paused: r.paused,
  };
}

/** Unit-variant enums decode as either "Approved" or ["Approved"]; normalise. */
function toStatus(raw: unknown): ComplianceStatus {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return String(v) as ComplianceStatus;
}

type RawKyc = {
  address: string;
  status: unknown;
  jurisdiction: string;
  verified_at: number;
  expires_at: number;
};

function toKycRecord(r: RawKyc): KycRecord {
  return {
    address: r.address,
    status: toStatus(r.status),
    jurisdiction: r.jurisdiction,
    verifiedAt: Number(r.verified_at),
    expiresAt: Number(r.expires_at),
  };
}

type RawDist = {
  id: bigint;
  asset_token: string;
  payment_token: string;
  total_amount: bigint;
  distributed: bigint;
  created_at: number;
  completed: boolean;
  claim_deadline?: number;
};

function toDistribution(r: RawDist): Distribution {
  return {
    id: BigInt(r.id),
    assetToken: r.asset_token,
    paymentToken: r.payment_token,
    totalAmount: BigInt(r.total_amount),
    distributed: BigInt(r.distributed),
    createdAt: Number(r.created_at),
    completed: r.completed,
    claimDeadline: r.claim_deadline === undefined ? 0 : Number(r.claim_deadline),
  };
}

// ================= Registry =================

/**
 * How many entries to request per page when calling the paginated
 * `get_all_assets(start_id, limit)` contract method.  50 is a safe default
 * that stays well inside Soroban's per-simulation instruction budget while
 * still reducing round trips for typical registries.
 */
const GET_ALL_ASSETS_PAGE_SIZE = 50;

export const registry = {
  /**
   * Fetches all assets from the registry, paging through them automatically.
   *
   * The contracts repo's registry (main branch) exposes:
   *   `get_all_assets(start_id: u64, limit: u32) -> Vec<AssetEntry>`
   *
   * This replaces the old no-argument signature which worked only with older
   * deployments.  For backward compatibility, if the first paginated call
   * fails with an argument-count error (indicating an old contract that takes
   * no arguments), the function retries with the legacy no-argument call and
   * logs a deprecation notice so operators know to upgrade.
   *
   * Paging continues until a page returns fewer entries than the page size,
   * which signals that we've reached the end of the list.
   */
  async getAllAssets(network: Network): Promise<AssetEntry[]> {
    const registryId = contractIds(network).registry;
    const limit = GET_ALL_ASSETS_PAGE_SIZE;
    const all: RawEntry[] = [];
    let startId = 0n;

    try {
      // Paginated path (new contract signature).
      while (true) {
        const page = await readContract<RawEntry[]>(
          network,
          registryId,
          "get_all_assets",
          [arg.u64(startId), arg.u32(limit)],
        );
        const entries = page ?? [];
        all.push(...entries);
        if (entries.length < limit) break;
        // Advance: the next page starts after the last entry's id. The break
        // above guarantees entries.length >= limit (> 0) here.
        startId = BigInt(entries[entries.length - 1]!.id) + 1n;
      }
    } catch (err) {
      // Detect argument-count mismatches from old deployments that take no
      // arguments.  Soroban surfaces these as a simulation error whose detail
      // contains "WrongNumberOfArguments" or "ArgsInvalid".
      const detail = err instanceof Error ? err.message + (err as { detail?: string }).detail : String(err);
      const isArgError = /WrongNumberOfArguments|ArgsInvalid|wrong.*arg|arg.*count/i.test(detail);
      if (!isArgError) throw err;

      // Fallback: legacy no-argument call.
      console.warn(
        "[registry.getAllAssets] Paginated call failed with an argument error — " +
        "falling back to the legacy no-argument get_all_assets. " +
        "Upgrade the registry contract to remove this fallback.",
      );
      const raw = await readContract<RawEntry[]>(
        network,
        registryId,
        "get_all_assets",
      );
      return (raw ?? []).map(toAssetEntry);
    }

    return all.map(toAssetEntry);
  },

  async getAsset(network: Network, id: bigint): Promise<AssetEntry> {
    const raw = await readContract<RawEntry>(
      network,
      contractIds(network).registry,
      "get_asset",
      [arg.u64(id)],
    );
    return toAssetEntry(raw);
  },

  async getAssetsByIssuer(network: Network, issuer: string): Promise<AssetEntry[]> {
    const raw = await readContract<RawEntry[]>(
      network,
      contractIds(network).registry,
      "get_assets_by_issuer",
      [arg.address(issuer)],
    );
    return (raw ?? []).map(toAssetEntry);
  },

  async getAssetsByType(network: Network, assetType: string): Promise<AssetEntry[]> {
    const raw = await readContract<RawEntry[]>(
      network,
      contractIds(network).registry,
      "get_assets_by_type",
      [arg.string(assetType)],
    );
    return (raw ?? []).map(toAssetEntry);
  },

  totalValueLocked(network: Network): Promise<bigint> {
    return readContract<bigint>(
      network,
      contractIds(network).registry,
      "total_value_locked",
    ).then((v) => BigInt(v ?? 0n));
  },

  assetCount(network: Network): Promise<bigint> {
    return readContract<bigint>(
      network,
      contractIds(network).registry,
      "asset_count",
    ).then((v) => BigInt(v ?? 0n));
  },

  registerAsset(
    ctx: WriteCtx,
    params: {
      issuer: string;
      tokenContract: string;
      name: string;
      assetType: string;
      valuation: bigint;
    },
  ): Promise<TxResult> {
    return write(ctx, contractIds(ctx.network).registry, "register_asset", [
      arg.address(params.issuer),
      arg.address(params.tokenContract),
      arg.string(params.name),
      arg.string(params.assetType),
      arg.i128(params.valuation),
    ]);
  },
};

// ================= Asset token =================

const decimalsCache = new Map<string, Promise<number>>();

export const assetToken = {
  getMetadata(network: Network, tokenId: string): Promise<AssetMetadata> {
    return readContract<RawMetadata>(network, tokenId, "get_metadata").then(
      toMetadata,
    );
  },

  decimals(network: Network, tokenId: string): Promise<number> {
    const key = `${network}:${tokenId}`;
    const cached = decimalsCache.get(key);
    if (cached) return cached;

    const pending = readContract<number>(network, tokenId, "decimals").then(
      (decimals) => {
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
          throw new Error(`Token ${tokenId} returned invalid decimals.`);
        }
        return decimals;
      },
    );
    decimalsCache.set(key, pending);
    void pending.catch(() => {
      if (decimalsCache.get(key) === pending) decimalsCache.delete(key);
    });
    return pending;
  },

  balance(network: Network, tokenId: string, holder: string): Promise<bigint> {
    return readContract<bigint>(network, tokenId, "balance", [
      arg.address(holder),
    ]).then((v) => BigInt(v ?? 0n));
  },

  /**
   * Returns the amount of `tokenId` that `spender` is allowed to transfer on
   * behalf of `owner` (SEP-41 `allowance`).
   */
  allowance(
    network: Network,
    tokenId: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    return readContract<bigint>(network, tokenId, "allowance", [
      arg.address(owner),
      arg.address(spender),
    ]).then((v) => BigInt(v ?? 0n));
  },

  totalSupply(network: Network, tokenId: string): Promise<bigint> {
    return readContract<bigint>(network, tokenId, "total_supply").then((v) =>
      BigInt(v ?? 0n),
    );
  },

  transfer(
    ctx: WriteCtx,
    tokenId: string,
    to: string,
    amount: bigint,
  ): Promise<TxResult> {
    return write(ctx, tokenId, "transfer", [
      arg.address(ctx.source),
      arg.address(to),
      arg.i128(amount),
    ]);
  },

  mint(
    ctx: WriteCtx,
    tokenId: string,
    to: string,
    amount: bigint,
  ): Promise<TxResult> {
    return write(ctx, tokenId, "mint", [
      arg.address(ctx.source),
      arg.address(to),
      arg.i128(amount),
    ]);
  },

  pause(ctx: WriteCtx, tokenId: string): Promise<TxResult> {
    return write(ctx, tokenId, "pause", [arg.address(ctx.source)]);
  },

  unpause(ctx: WriteCtx, tokenId: string): Promise<TxResult> {
    return write(ctx, tokenId, "unpause", [arg.address(ctx.source)]);
  },
};

// ================= Compliance =================

export const compliance = {
  isAllowed(network: Network, complianceId: string, address: string): Promise<boolean> {
    return readContract<boolean>(network, complianceId, "is_allowed", [
      arg.address(address),
    ]).then(Boolean);
  },

  async getRecord(
    network: Network,
    complianceId: string,
    address: string,
  ): Promise<KycRecord | null> {
    const raw = await readContract<RawKyc | null>(
      network,
      complianceId,
      "get_record",
      [arg.address(address)],
    );
    return raw ? toKycRecord(raw) : null;
  },

  getAllowlist(network: Network, complianceId: string): Promise<string[]> {
    return readContract<string[]>(network, complianceId, "get_allowlist").then(
      (v) => v ?? [],
    );
  },

  isJurisdictionBlocked(
    network: Network,
    complianceId: string,
    jurisdiction: string,
  ): Promise<boolean> {
    return readContract<boolean>(network, complianceId, "is_jurisdiction_blocked", [
      arg.string(jurisdiction),
    ]).then(Boolean);
  },

  addToAllowlist(
    ctx: WriteCtx,
    complianceId: string,
    address: string,
    jurisdiction: string,
    expiresAt: number,
  ): Promise<TxResult> {
    return write(ctx, complianceId, "add_to_allowlist", [
      arg.address(ctx.source),
      arg.address(address),
      arg.string(jurisdiction),
      arg.u32(expiresAt),
    ]);
  },

  suspend(ctx: WriteCtx, complianceId: string, address: string): Promise<TxResult> {
    return write(ctx, complianceId, "suspend", [
      arg.address(ctx.source),
      arg.address(address),
    ]);
  },

  remove(ctx: WriteCtx, complianceId: string, address: string): Promise<TxResult> {
    return write(ctx, complianceId, "remove", [
      arg.address(ctx.source),
      arg.address(address),
    ]);
  },

  blockJurisdiction(
    ctx: WriteCtx,
    complianceId: string,
    jurisdiction: string,
  ): Promise<TxResult> {
    return write(ctx, complianceId, "block_jurisdiction", [
      arg.address(ctx.source),
      arg.string(jurisdiction),
    ]);
  },

  unblockJurisdiction(
    ctx: WriteCtx,
    complianceId: string,
    jurisdiction: string,
  ): Promise<TxResult> {
    return write(ctx, complianceId, "unblock_jurisdiction", [
      arg.address(ctx.source),
      arg.string(jurisdiction),
    ]);
  },
};

// ================= Dividend =================

export const dividend = {
  getDistributionsForAsset(
    network: Network,
    assetToken: string,
  ): Promise<Distribution[]> {
    return readContract<RawDist[]>(
      network,
      contractIds(network).dividend,
      "get_distributions_for_asset",
      [arg.address(assetToken)],
    ).then((v) => (v ?? []).map(toDistribution));
  },

  getDistribution(network: Network, id: bigint): Promise<Distribution> {
    return readContract<RawDist>(
      network,
      contractIds(network).dividend,
      "get_distribution",
      [arg.u64(id)],
    ).then(toDistribution);
  },

  claimable(network: Network, id: bigint, holder: string): Promise<bigint> {
    return readContract<bigint>(
      network,
      contractIds(network).dividend,
      "claimable",
      [arg.u64(id), arg.address(holder)],
    ).then((v) => BigInt(v ?? 0n));
  },

  hasClaimed(network: Network, id: bigint, holder: string): Promise<boolean> {
    return readContract<boolean>(
      network,
      contractIds(network).dividend,
      "has_claimed",
      [arg.u64(id), arg.address(holder)],
    ).then(Boolean);
  },

  createDistribution(
    ctx: WriteCtx,
    assetToken: string,
    paymentToken: string,
    totalAmount: bigint,
    eligible: readonly (readonly [string, bigint])[],
    claimDeadline = 0,
  ): Promise<TxResult> {
    const args = [
      arg.address(ctx.source),
      arg.address(assetToken),
      arg.address(paymentToken),
      arg.i128(totalAmount),
      arg.vecOfTuples(eligible),
    ];
    if (claimDeadline > 0) {
      return write(
        ctx,
        contractIds(ctx.network).dividend,
        "create_distribution_deadline",
        [...args, arg.u32(claimDeadline)],
      );
    }
    return write(ctx, contractIds(ctx.network).dividend, "create_distribution", args);
  },

  claim(ctx: WriteCtx, id: bigint): Promise<TxResult> {
    return write(ctx, contractIds(ctx.network).dividend, "claim", [
      arg.u64(id),
      arg.address(ctx.source),
    ]);
  },
};
