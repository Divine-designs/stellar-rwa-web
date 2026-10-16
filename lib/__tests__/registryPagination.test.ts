/**
 * Tests for issue #526 — registry.getAllAssets pagination.
 *
 * The contracts repo's registry now takes (start_id: u64, limit: u32).
 * registry.getAllAssets must page through the registry automatically and
 * also fall back gracefully to the old no-argument signature when the
 * deployed contract is older.
 */

jest.mock("@/lib/stellar", () => ({
  readContract: jest.fn(),
  arg: jest.requireActual("@/lib/stellar").arg,
}));

import { registry } from "@/lib/contracts";
import { readContract } from "@/lib/stellar";

// Minimal raw asset fixture matching the RawEntry shape in lib/contracts.ts.
function makeRawEntry(id: number) {
  return {
    id: BigInt(id),
    token_contract: `CTOKEN${id}`,
    issuer: "GISSUER",
    name: `Asset ${id}`,
    asset_type: "real_estate",
    valuation: BigInt(1_000_000),
    created_at: 1000 + id,
    active: true,
  };
}

const mockReadContract = readContract as jest.Mock;

const PAGE_SIZE = 50; // must match GET_ALL_ASSETS_PAGE_SIZE in contracts.ts

describe("registry.getAllAssets (#526)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls get_all_assets with start_id=0 and limit on the first request", async () => {
    mockReadContract.mockResolvedValue([]);
    await registry.getAllAssets("testnet");

    expect(mockReadContract).toHaveBeenCalledWith(
      "testnet",
      expect.any(String),
      "get_all_assets",
      [expect.objectContaining({ type: "scvU64" }), expect.objectContaining({ type: "scvU32" })],
    );
  });

  it("returns all entries when the first page is shorter than the page size (single page)", async () => {
    const entries = [makeRawEntry(1), makeRawEntry(2), makeRawEntry(3)];
    mockReadContract.mockResolvedValue(entries);

    const result = await registry.getAllAssets("testnet");

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe(1n);
    expect(result[2]!.id).toBe(3n);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });

  it("fetches multiple full pages until a short page signals end-of-list", async () => {
    // Page 1: full (50 entries ids 0-49), Page 2: full (50 entries ids 50-99), Page 3: partial
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => makeRawEntry(i));
    const page2 = Array.from({ length: PAGE_SIZE }, (_, i) => makeRawEntry(PAGE_SIZE + i));
    const page3 = [makeRawEntry(PAGE_SIZE * 2), makeRawEntry(PAGE_SIZE * 2 + 1)];

    mockReadContract
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3);

    const result = await registry.getAllAssets("testnet");

    expect(mockReadContract).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(PAGE_SIZE * 2 + 2);
  });

  it("advances start_id correctly between pages", async () => {
    // page1 ends with id 49; page2 should start at id 50
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => makeRawEntry(i));
    const page2 = [makeRawEntry(PAGE_SIZE)]; // short page

    mockReadContract
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    await registry.getAllAssets("testnet");

    // Second call should have start_id = 50 (last id 49 + 1)
    const secondCallArgs = mockReadContract.mock.calls[1];
    // The u64 scVal encodes the BigInt value; we check via scValToNative
    const { scValToNative } = jest.requireActual("@stellar/stellar-sdk");
    const startIdArg = secondCallArgs[3][0];
    expect(scValToNative(startIdArg)).toBe(BigInt(PAGE_SIZE));
  });

  it("returns an empty array when the first page is empty", async () => {
    mockReadContract.mockResolvedValue([]);
    const result = await registry.getAllAssets("testnet");
    expect(result).toEqual([]);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when readContract returns null (no assets)", async () => {
    mockReadContract.mockResolvedValue(null);
    const result = await registry.getAllAssets("testnet");
    expect(result).toEqual([]);
  });

  it("maps raw snake_case fields to camelCase AssetEntry", async () => {
    const raw = makeRawEntry(7);
    mockReadContract.mockResolvedValue([raw]);

    const [entry] = await registry.getAllAssets("testnet");
    if (!entry) throw new Error("expected one entry");

    expect(entry.id).toBe(7n);
    expect(entry.tokenContract).toBe("CTOKEN7");
    expect(entry.assetType).toBe("real_estate");
    expect(entry.valuation).toBe(1_000_000n);
    expect(entry.createdAt).toBe(1007);
    expect(entry.active).toBe(true);
  });

  describe("backward-compatibility fallback for old no-argument registry", () => {
    it("falls back to no-argument call on WrongNumberOfArguments error", async () => {
      const legacyEntries = [makeRawEntry(1), makeRawEntry(2)];
      const argError = new Error("WrongNumberOfArguments");
      mockReadContract
        .mockRejectedValueOnce(argError)   // paginated call fails
        .mockResolvedValueOnce(legacyEntries); // no-arg fallback succeeds

      const result = await registry.getAllAssets("testnet");

      expect(result).toHaveLength(2);
      // Fallback call has no extra args array
      expect(mockReadContract).toHaveBeenCalledTimes(2);
      const fallbackCall = mockReadContract.mock.calls[1];
      expect(fallbackCall[3]).toBeUndefined();
    });

    it("falls back to no-argument call on ArgsInvalid error", async () => {
      const legacyEntries = [makeRawEntry(5)];
      mockReadContract
        .mockRejectedValueOnce(new Error("ArgsInvalid: count mismatch"))
        .mockResolvedValueOnce(legacyEntries);

      const result = await registry.getAllAssets("testnet");
      expect(result).toHaveLength(1);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Upgrade the registry contract"),
      );
    });

    it("does not swallow non-argument errors", async () => {
      mockReadContract.mockRejectedValueOnce(new Error("Network timeout"));

      await expect(registry.getAllAssets("testnet")).rejects.toThrow("Network timeout");
      // Should not attempt a fallback call.
      expect(mockReadContract).toHaveBeenCalledTimes(1);
    });
  });
});
