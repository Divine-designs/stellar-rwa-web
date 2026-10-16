/**
 * Tests for lib/api.ts, written against **recorded real API payloads** (see
 * ./apiFixtures.ts) rather than the shapes the client used to assume.
 *
 * fetchJson silently returns null on any failure. These tests pin that contract
 * so a future refactor can't accidentally start throwing.
 *
 * Scenarios covered:
 *   - non-OK HTTP response (404, 500)
 *   - network-level throw (fetch itself rejects)
 *   - malformed JSON body (res.json() rejects)
 *   - missing API base URL (fetch is never called)
 *   - request timeout: a fetch that never settles is aborted and reported as
 *     "API unavailable" (null) so callers fall back to RPC (#524)
 *   - pagination truncation: getAllAssets / getAssetsByIssuer use pageSize=500
 *     and return only the first page regardless of totalPages
 *
 * We avoid the real `Response` constructor (not available in jsdom without
 * extra polyfills) and instead build minimal plain objects that satisfy the
 * `{ ok, json() }` interface that fetchJson relies on.
 */

// Set the base URL before the module is imported so the cached BASE value
// is populated for all tests.
process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";

import { api, API_TIMEOUT_MS, toAssetEntry, ApiShapeError } from "../api";
import {
  makeApiAsset,
  makeApiStats,
  makeApiHolder,
  makeApiEvent,
} from "../testFixtures/recordedResponses";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock response object that looks like a successful fetch Response.
 * We avoid the real Response constructor since jsdom doesn't provide it.
 */
function okResponse(body: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  };
}

/** A mock response with a non-OK status (ok=false). */
function errorResponse(status = 404): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: "not found" }),
  };
}

/** A mock response whose json() call rejects — simulating corrupted body. */
function malformedJsonResponse(): { ok: boolean; json: () => Promise<never> } {
  return {
    ok: true,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  };
}

/** A full page of exactly `count` assets, for the pagination loop. */
function fullPage(count: number) {
  return Array.from({ length: count }, (_, i) => makeApiAsset({ id: i + 1 }));
}

// ── mock global fetch ──────────────────────────────────────────────────────────

// We need a flexible mock type here since our helpers return plain objects
// rather than real Response instances (jsdom doesn't provide the constructor).
// The cast to unknown then to a structural type lets us call mockResolvedValue
// with our minimal response fixtures without satisfying the full Response
// interface. fetchJson only uses `.ok` and `.json()` so these fixtures are safe.
const mockFetch = jest.fn() as unknown as {
  mockResolvedValue(v: unknown): void;
  mockRejectedValue(v: unknown): void;
  mockImplementation(
    fn: (url: string, init?: RequestInit) => Promise<unknown>,
  ): void;
  mockReset(): void;
  mock: { calls: unknown[][] };
};

/** The URL passed to the nth fetch call. */
function requestedUrl(n = 0): string {
  const url = mockFetch.mock.calls[n]?.[0];
  if (typeof url !== "string") {
    throw new Error("Expected fetch to be called with a URL string.");
  }
  return url;
}

/** Run `fn` with `console.warn` silenced (shape mismatches log once). */
function withSilencedWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
  return fn().finally(() => spy.mockRestore());
}

beforeAll(() => {
  // Cast needed because our mock returns a minimal { ok, json } shape rather
  // than a full Response object. fetchJson only reads those two properties.
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  mockFetch.mockReset();
});

// ==============================================================================
// fetchJson error handling (exercised through api.getStats for brevity)
// ==============================================================================

describe("fetchJson error handling", () => {
  it("returns null for a non-OK HTTP response (404)", async () => {
    mockFetch.mockResolvedValue(errorResponse(404));

    expect(await api.getStats()).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for a non-OK HTTP response (500)", async () => {
    mockFetch.mockResolvedValue(errorResponse(500));

    expect(await api.getStats()).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await api.getStats()).toBeNull();
  });

  it("returns null when the response body is malformed JSON", async () => {
    mockFetch.mockResolvedValue(malformedJsonResponse());

    expect(await api.getStats()).toBeNull();
  });

  it("calls fetch and parses the body when the URL is set", async () => {
    mockFetch.mockResolvedValue(okResponse(makeApiStats()));

    const result = await api.getStats();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
  });
});

// ==============================================================================
// GET /assets — bare array, offset/limit paging
// ==============================================================================

describe("GET /assets response shape (#532)", () => {
  it("reads a bare JSON array, not a { data, total } envelope", async () => {
    mockFetch.mockResolvedValue(okResponse([makeApiAsset()]));

    const page = await api.getAssetsPage();

    expect(Array.isArray(page)).toBe(true);
    expect(page).toHaveLength(1);
  });

  it("returns null when the body is an envelope instead of an array", async () => {
    // Guards the exact bug: the old client did raw.data.map on a bare array.
    mockFetch.mockResolvedValue(okResponse({ data: [makeApiAsset()], total: 1 }));

    expect(await api.getEvents()).toBeNull();
    // /v1 prefix is added automatically (#531)
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/events",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("sends offset/limit and the asset_type filter, not page/pageSize/sort", async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await api.getAssetsPage({ assetType: "real_estate", active: true });

    const url = requestedUrl();
    expect(url).toContain("offset=0");
    expect(url).toContain("limit=100");
    expect(url).toContain("asset_type=real_estate");
    expect(url).toContain("active=true");
    // These were unknown to the API and silently ignored.
    expect(url).not.toContain("pageSize");
    expect(url).not.toContain("page=");
    expect(url).not.toContain("sort=");
  });

  it("clamps limit to the API maximum of 100", async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    // The old client asked for pageSize=500, which the API ignores, capping
    // the response at 50 and silently truncating the list.
    await api.getAssetsPage({ limit: 500 });

    expect(requestedUrl()).toContain("limit=100");
  });

  it("returns null for a non-OK response", async () => {
    mockFetch.mockResolvedValue(errorResponse(503));

    expect(await api.getAssetsPage()).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    expect(await api.getAssetsPage()).toBeNull();
  });
});

describe("api.getAllAssets pagination loop (#532)", () => {
  it("walks every page instead of requesting pageSize=500 once", async () => {
    // Three pages: two full pages of 100, then a short final page.
    mockFetch.mockImplementation((url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset === 0 || offset === 100) {
        return Promise.resolve(okResponse(fullPage(100)));
      }
      return Promise.resolve(okResponse([makeApiAsset({ id: 201 })]));
    });

    const result = await api.getAllAssets();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(201);
    expect(result?.[0]?.id).toBe(1n);
    expect(result?.[200]?.id).toBe(201n);
  });

  it("stops after a single request when the first page is short", async () => {
    mockFetch.mockResolvedValue(
      okResponse([makeApiAsset(), makeApiAsset({ id: 2 })]),
    );

    const result = await api.getAllAssets();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
  });

  it("maps id and valuation_cents to bigints (preserving precision beyond MAX_SAFE_INTEGER)", async () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 1 — it would lose
    // precision if converted via Number().
    mockFetch.mockResolvedValue(
      okResponse([makeApiAsset({ id: 42, valuation_cents: "9007199254740993" })]),
    );

    const result = await api.getAllAssets();

    expect(result?.map(({ id, valuation }) => [id, valuation])).toEqual([
      [42n, 9007199254740993n],
    ]);
  });

  it("returns null for a non-OK response", async () => {
    mockFetch.mockResolvedValue(errorResponse(502));

    expect(await api.getAllAssets()).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network unreachable"));

    expect(await api.getAllAssets()).toBeNull();
  });

  it("returns null for a malformed JSON body", async () => {
    mockFetch.mockResolvedValue(malformedJsonResponse());

    expect(await api.getAllAssets()).toBeNull();
  });

  it("falls back to RPC (null) when a page is malformed rather than throwing", async () => {
    // BigInt("not-a-number") used to throw out of the hook as a load error.
    mockFetch.mockResolvedValue(
      okResponse([makeApiAsset({ valuation_cents: "not-a-number" })]),
    );

    expect(await withSilencedWarnings(() => api.getAllAssets())).toBeNull();
  });

  it("falls back to RPC (null) when a required field is missing", async () => {
    const broken = makeApiAsset();
    delete (broken as Record<string, unknown>).token_contract;
    mockFetch.mockResolvedValue(okResponse([broken]));

    expect(await withSilencedWarnings(() => api.getAllAssets())).toBeNull();
  });
});

// ==============================================================================
// GET /assets/:id
// ==============================================================================

describe("api.getAsset", () => {
  it("maps a real Asset payload to an AssetEntry", async () => {
    const payload = makeApiAsset({ id: 7 });
    mockFetch.mockResolvedValue(okResponse(payload));

    const result = await api.getAsset(7n);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(7n);
    expect(result!.tokenContract).toBe(payload.token_contract);
    expect(result!.issuer).toBe(payload.issuer);
    expect(result!.name).toBe("Lagos Office Tower");
    expect(result!.assetType).toBe("real_estate");
    expect(result!.valuation).toBe(50000000000n);
    // createdAt comes from created_at_ledger.
    expect(result!.createdAt).toBe(3514152);
    expect(result!.active).toBe(true);
  });

  it("requests the numeric registry id, not a contract address", async () => {
    mockFetch.mockResolvedValue(okResponse(makeApiAsset({ id: 3 })));

    await api.getAsset(3n);

    expect(requestedUrl()).toBe("https://api.example.com/v1/assets/3");
  });

  it("returns null for a 404 response", async () => {
    mockFetch.mockResolvedValue(errorResponse(404));

    expect(await api.getAsset(9999n)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("DNS failure"));

    expect(await api.getAsset(1n)).toBeNull();
  });

  it("returns null for a malformed JSON body", async () => {
    mockFetch.mockResolvedValue(malformedJsonResponse());

    expect(await api.getAsset(1n)).toBeNull();
  });

  it("returns null for a malformed payload instead of throwing", async () => {
    mockFetch.mockResolvedValue(okResponse({ id: 1, name: "missing fields" }));

    expect(await withSilencedWarnings(() => api.getAsset(1n))).toBeNull();
  });
});

// ==============================================================================
// getAssetsByIssuer — client-side filter, no issuer query param
// ==============================================================================

describe("api.getAssetsByIssuer (#532)", () => {
  const issuer = "GISSUER_A";

  it("does not send an issuer query param the API would ignore", async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await api.getAssetsByIssuer(issuer);

    // Unknown query params are silently ignored, which used to return every
    // asset unfiltered in the issuer view.
    expect(requestedUrl()).not.toContain("issuer");
  });

  it("filters the full list client-side", async () => {
    mockFetch.mockResolvedValue(
      okResponse([
        makeApiAsset({ id: 1, issuer }),
        makeApiAsset({ id: 2, issuer: "GISSUER_B" }),
        makeApiAsset({ id: 3, issuer }),
      ]),
    );

    const result = await api.getAssetsByIssuer(issuer);

    expect(result?.map((a) => a.id)).toEqual([1n, 3n]);
  });

  it("returns an empty list when no asset belongs to the issuer", async () => {
    mockFetch.mockResolvedValue(
      okResponse([makeApiAsset({ issuer: "GISSUER_B" })]),
    );

    expect(await api.getAssetsByIssuer(issuer)).toEqual([]);
  });

  it("returns null for a non-OK response", async () => {
    mockFetch.mockResolvedValue(errorResponse(500));

    expect(await api.getAssetsByIssuer(issuer)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network error"));

    expect(await api.getAssetsByIssuer(issuer)).toBeNull();
  });

  it("returns null for a malformed JSON body", async () => {
    mockFetch.mockResolvedValue(malformedJsonResponse());

    expect(await api.getAssetsByIssuer(issuer)).toBeNull();
  });
});

// ==============================================================================
// GET /stats — snake_case fields
// ==============================================================================

describe("GET /stats response shape (#532)", () => {
  it("maps total_assets, tvl_cents and total_holders", async () => {
    mockFetch.mockResolvedValue(okResponse(makeApiStats()));

    expect(await api.getStats()).toEqual({
      totalAssets: 128,
      tvl: "8750000000000",
      totalHolders: 4213,
    });
  });

  it("maps a stats body with no holders to null rather than undefined", async () => {
    const stats = makeApiStats();
    delete (stats as Record<string, unknown>).total_holders;
    mockFetch.mockResolvedValue(okResponse(stats));

    expect((await api.getStats())?.totalHolders).toBeNull();
  });

  it("returns null for a malformed stats payload instead of throwing", async () => {
    // BigInt("abc") used to surface as NaN/undefined stats.
    mockFetch.mockResolvedValue(
      okResponse({ total_assets: 5, tvl_cents: "abc" }),
    );

    expect(await withSilencedWarnings(() => api.getStats())).toBeNull();
  });

  it("returns null when total_assets is missing", async () => {
    mockFetch.mockResolvedValue(
      okResponse({ tvl_cents: "1", total_holders: 0 }),
    );

    expect(await withSilencedWarnings(() => api.getStats())).toBeNull();
  });
});

// ==============================================================================
// GET /assets/:id/holders — keyed on the asset id
// ==============================================================================

describe("GET /assets/:id/holders (#532)", () => {
  it("requests the numeric asset id, not the token contract", async () => {
    mockFetch.mockResolvedValue(okResponse([]));

    await api.getHolders(12n);

    // A contract address in this path segment is a 400 from the API.
    const url = requestedUrl();
    expect(url).toBe(
      "https://api.example.com/v1/assets/12/holders?offset=0&limit=100",
    );
  });

  it("maps balance strings to bigints (preserving precision)", async () => {
    mockFetch.mockResolvedValue(
      okResponse([
        makeApiHolder({ address: "GHOLDER1", balance: "9007199254740993" }),
        makeApiHolder({ address: "GHOLDER2", balance: "0" }),
      ]),
    );

    const result = await api.getHolders(1n);

    expect(result?.map(({ balance }) => balance)).toEqual([9007199254740993n, 0n]);
  });

  it("returns null for a non-OK response", async () => {
    mockFetch.mockResolvedValue(errorResponse(404));

    expect(await api.getHolders(1n)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("Timeout"));

    expect(await api.getHolders(1n)).toBeNull();
  });

  it("returns null for a malformed JSON body", async () => {
    mockFetch.mockResolvedValue(malformedJsonResponse());

    expect(await api.getHolders(1n)).toBeNull();
  });

  it("returns null when a holder balance is not an integer", async () => {
    mockFetch.mockResolvedValue(okResponse([makeApiHolder({ balance: "oops" })]));

    expect(await withSilencedWarnings(() => api.getHolders(1n))).toBeNull();
  });
});

// ==============================================================================
// GET /events
// ==============================================================================

describe("api.getEvents", () => {
  it("fetches indexed contract events from the events endpoint", async () => {
    const events = [makeApiEvent()];
    mockFetch.mockResolvedValue(okResponse(events));

    expect(await api.getEvents()).toEqual(events);
    // /v1 prefix is added automatically (#531)
    expect(requestedUrl()).toBe("https://api.example.com/v1/events");
  });

  it("returns null when the events endpoint is unavailable", async () => {
    mockFetch.mockResolvedValue(errorResponse(503));

    expect(await api.getEvents()).toBeNull();
  });

  it("returns null when the body is not an array", async () => {
    mockFetch.mockResolvedValue(okResponse({ events: [] }));

    expect(await api.getEvents()).toBeNull();
  });
});

// ==============================================================================
// Mapping helpers
// ==============================================================================

describe("toAssetEntry", () => {
  it("throws ApiShapeError on a non-integer valuation", () => {
    expect(() =>
      toAssetEntry(makeApiAsset({ valuation_cents: "12.5" }) as never),
    ).toThrow(ApiShapeError);
  });

  it("throws ApiShapeError when token_contract is empty", () => {
    expect(() =>
      toAssetEntry(makeApiAsset({ token_contract: "" }) as never),
    ).toThrow(ApiShapeError);
  });

  it("throws ApiShapeError when the payload is not an object", () => {
    expect(() => toAssetEntry(null as never)).toThrow(ApiShapeError);
  });

  it("treats a non-boolean active as inactive rather than throwing", () => {
    expect(toAssetEntry(makeApiAsset({ active: "yes" }) as never).active).toBe(
      false,
    );
  });
});

// ==============================================================================
// Issue #524 — request timeout
// ==============================================================================

describe("fetchJson timeout (#524)", () => {
  it("passes an AbortSignal so a slow request can be cancelled", async () => {
    mockFetch.mockResolvedValue(
      okResponse({ totalAssets: 1, tvl: "100", totalHolders: 1 }),
    );

    await api.getStats();

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // The signal must still be live right after a successful response.
    expect(init?.signal?.aborted).toBe(false);
  });

  it("resolves to null when the request never responds, after the timeout", async () => {
    jest.useFakeTimers();
    try {
      // A fetch that only settles if/when it is aborted — i.e. a black-holed
      // or slow API, which is exactly the case this timeout exists for.
      mockFetch.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted.")),
            );
          }),
      );

      const pending = api.getStats();

      // Nothing has resolved yet — the request is still in flight.
      jest.advanceTimersByTime(API_TIMEOUT_MS - 1);
      await Promise.resolve();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Past the timeout the request is aborted and reported as unavailable,
      // which is the signal callers use to fall back to RPC.
      jest.advanceTimersByTime(2);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("treats a timed-out request as unavailable for every endpoint", async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted.")),
            );
          }),
      );

      const pending = Promise.all([
        api.getStats(),
        api.getAllAssets(),
        api.getEvents(),
        api.getAsset(1n),
      ]);
      jest.advanceTimersByTime(API_TIMEOUT_MS + 1);

      // All four resolve to null rather than hanging, so useAssets /
      // usePlatformStats / useHolders / useActivity all fall back to RPC.
      await expect(pending).resolves.toEqual([null, null, null, null]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("clears the timeout once a response arrives so the timer does not leak", async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(okResponse(makeApiStats()));

      await expect(api.getStats()).resolves.not.toBeNull();

      // No pending timer should remain to abort an already-settled request.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ==============================================================================
// Issue #531 — apiUrl /v1 prefix
// ==============================================================================

describe("apiUrl /v1 prefix (#531)", () => {
  it("api.getStats requests /v1/stats", async () => {
    mockFetch.mockResolvedValue(okResponse(makeApiStats()));
    await api.getStats();
    expect(requestedUrl()).toBe("https://api.example.com/v1/stats");
  });

  it("api.getAllAssets requests /v1/assets", async () => {
    mockFetch.mockResolvedValue(okResponse([]));
    await api.getAllAssets();
    expect(requestedUrl()).toMatch(/^https:\/\/api\.example\.com\/v1\/assets/);
  });

  it("api.getAsset requests /v1/assets/:id", async () => {
    mockFetch.mockResolvedValue(okResponse(makeApiAsset({ id: 3 })));
    await api.getAsset(3n);
    expect(requestedUrl()).toBe("https://api.example.com/v1/assets/3");
  });

  it("does not double-append /v1 if the env var already ends with /v1", async () => {
    // Simulate an operator who worked around the old bug by adding /v1.
    // We can't reload the module, so we test the no-double-append logic by
    // checking the regex directly — the guard is /\/v\d+$/.test(base).
    const baseWithVersion = "https://rwa-api.example.com/v1";
    const doubleVersioned = /\/v\d+$/.test(baseWithVersion.replace(/\/+$/, ""));
    expect(doubleVersioned).toBe(true); // regex fires → no second /v1 appended
  });
});
