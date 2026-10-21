/**
 * Tests for components/asset/AssetExplorer.tsx
 *
 * Strategy: mock useAssets so the component renders without any Soroban / Stellar
 * SDK calls. Mock useSearchParams and useRouter from Next.js navigation so URL-
 * based filter state can be exercised without a real router. Then drive the
 * component through loading, error, empty and populated states, and assert that
 * the type-filter chip correctly narrows the rendered list.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AssetEntry } from "@/types";

// ── mock useAssets hook ────────────────────────────────────────────────────
jest.mock("@/hooks/useAssets", () => ({
  useAssets: jest.fn(),
}));

jest.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ network: "testnet" }),
}));

// ── mock Next.js navigation ────────────────────────────────────────────────
const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: jest.fn(() => ({ push: mockPush, replace: mockReplace })),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

// AssetCard renders a link to /asset/<id> — mock Next.js Link so it renders
// as a plain <a> tag without needing the Next.js router.
jest.mock("next/link", () => {
  const MockLink = ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>;
  MockLink.displayName = "MockLink";
  return MockLink;
});

import { useSearchParams, useRouter } from "next/navigation";
import { useAssets } from "@/hooks/useAssets";
import { AssetExplorer } from "../AssetExplorer";

const mockUseAssets = useAssets as jest.MockedFunction<typeof useAssets>;
const mockUseSearchParams = useSearchParams as jest.MockedFunction<typeof useSearchParams>;
const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>;

// ── helpers ────────────────────────────────────────────────────────────────

type UseAssetsReturn = ReturnType<typeof useAssets>;

function setupMock(state: Partial<UseAssetsReturn>, searchParamsStr = "") {
  mockUseAssets.mockReturnValue({
    assets: [],
    loading: false,
    error: null,
    refetch: jest.fn(),
    data: [],
    ...state,
  } as UseAssetsReturn);

  mockUseSearchParams.mockReturnValue(
    new URLSearchParams(searchParamsStr) as ReturnType<typeof useSearchParams>,
  );

  mockUseRouter.mockReturnValue(
    { push: mockPush, replace: mockReplace } as unknown as ReturnType<typeof useRouter>,
  );
}

function makeAsset(
  overrides: Partial<AssetEntry> & Pick<AssetEntry, "id" | "name">,
): AssetEntry {
  return {
    tokenContract: "CTOKEN123",
    issuer: "GISSUER123",
    assetType: "real_estate",
    valuation: 1_000_000_00n,
    createdAt: 100,
    active: true,
    ...overrides,
  };
}

const REAL_ESTATE_ASSET = makeAsset({
  id: 1n,
  name: "Lagos Office Tower",
  assetType: "real_estate",
  valuation: 5_000_000_00n,
  createdAt: 200,
});

const INVOICE_ASSET = makeAsset({
  id: 2n,
  name: "Trade Invoice #42",
  assetType: "invoice",
  valuation: 250_000_00n,
  createdAt: 100,
});

const COMMODITY_ASSET = makeAsset({
  id: 3n,
  name: "Gold Reserve",
  assetType: "commodity",
  valuation: 750_000_00n,
  createdAt: 150,
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("AssetExplorer", () => {
  afterEach(() => jest.clearAllMocks());

  // ── loading state ──────────────────────────────────────────────────────

  it("renders a skeleton grid while assets are loading", () => {
    setupMock({ loading: true, assets: [] });
    render(<AssetExplorer />);

    // CardSkeletonGrid renders Skeleton elements, each with aria-hidden="true".
    // We check that at least one is present to confirm the loading state is shown.
    const skeletons = document.querySelectorAll('[aria-hidden="true"]');
    expect(skeletons.length).toBeGreaterThan(0);

    // No real asset content or error alert should be visible during loading
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // ── error state ────────────────────────────────────────────────────────

  it("renders an error state with a retry button when the hook returns an error", () => {
    const mockRefetch = jest.fn();
    setupMock({ error: "RPC connection timed out", refetch: mockRefetch });

    render(<AssetExplorer />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("RPC connection timed out")).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryBtn);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  // ── empty state ────────────────────────────────────────────────────────

  it("shows an empty-state message when there are no assets at all", () => {
    setupMock({ assets: [] });
    render(<AssetExplorer />);

    expect(
      screen.getByText("No assets tokenized yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/be the first to bring a real-world asset on-chain/i),
    ).toBeInTheDocument();
  });

  it("shows a type-specific empty state when the active filter has no matches", () => {
    // The URL already has type=invoice, but only a real_estate asset exists.
    setupMock({ assets: [REAL_ESTATE_ASSET] }, "type=invoice");
    render(<AssetExplorer />);

    expect(screen.getByText("No assets of this type")).toBeInTheDocument();
    expect(
      screen.getByText(/try a different asset class or clear the filter/i),
    ).toBeInTheDocument();
  });

  // ── populated state ────────────────────────────────────────────────────

  it("renders all assets when no type filter is active", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] });
    render(<AssetExplorer />);

    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.getByText("Trade Invoice #42")).toBeInTheDocument();
    expect(screen.getByText("Gold Reserve")).toBeInTheDocument();
  });

  it("searches asset names without regard to case", () => {
    setupMock(
      { assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] },
      "q=LAGOS",
    );
    render(<AssetExplorer />);

    expect(screen.getByRole("searchbox", { name: "Search assets" })).toHaveValue("LAGOS");
    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.queryByText("Trade Invoice #42")).not.toBeInTheDocument();
    expect(screen.queryByText("Gold Reserve")).not.toBeInTheDocument();
  });

  it("restores search and filters from their URL parameters", () => {
    setupMock(
      { assets: [REAL_ESTATE_ASSET, INVOICE_ASSET] },
      "q=lagos&type=real_estate&sort=newest",
    );
    render(<AssetExplorer />);

    expect(screen.getByRole("searchbox", { name: "Search assets" })).toHaveValue("lagos");
    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.queryByText("Trade Invoice #42")).not.toBeInTheDocument();
  });

  it("updates q in the URL, preserves other filters, and resets pagination", () => {
    jest.useFakeTimers();
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET] }, "type=invoice&sort=newest&page=2");
    render(<AssetExplorer />);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "  trade invoice  " },
    });
    jest.advanceTimersByTime(300);

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const url: string = mockReplace.mock.calls[0][0];
    expect(url).toContain("q=trade+invoice");
    expect(url).toContain("type=invoice");
    expect(url).toContain("sort=newest");
    expect(url).not.toContain("page=");
    jest.useRealTimers();
  });

  it("removes q from the URL when the search field is cleared", () => {
    jest.useFakeTimers();
    setupMock({ assets: [REAL_ESTATE_ASSET] }, "q=lagos");
    render(<AssetExplorer />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    jest.advanceTimersByTime(300);

    expect(mockReplace).toHaveBeenCalledWith("/explore", { scroll: false });
    jest.useRealTimers();
  });

  it.each([
    ["asset ID", "2"],
    ["issuer address", "gissuerxyz"],
    ["token contract address", "ctokenxyz"],
  ])("searches by %s", (_field, query) => {
    setupMock({
      assets: [
        {
          ...REAL_ESTATE_ASSET,
          issuer: "GISSUERABC",
          tokenContract: "CTOKENABC",
        },
        {
          ...INVOICE_ASSET,
          issuer: "GISSUERXYZ",
          tokenContract: "CTOKENXYZ",
        },
      ],
    }, `q=${query}`);
    render(<AssetExplorer />);

    expect(screen.getByText("Trade Invoice #42")).toBeInTheDocument();
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
  });

  it("shows a search-specific empty state when there are no matches", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET] }, "q=not+an+asset");
    render(<AssetExplorer />);

    expect(screen.getByText("No assets found")).toBeInTheDocument();
    expect(screen.getByText(/clear the search field/i)).toBeInTheDocument();
  });

  // ── URL-based filtering ────────────────────────────────────────────────

  it("shows only real-estate assets when type=real_estate is in the URL", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] }, "type=real_estate");
    render(<AssetExplorer />);

    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.queryByText("Trade Invoice #42")).not.toBeInTheDocument();
    expect(screen.queryByText("Gold Reserve")).not.toBeInTheDocument();
  });

  it("shows only invoice assets when type=invoice is in the URL", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] }, "type=invoice");
    render(<AssetExplorer />);

    expect(screen.getByText("Trade Invoice #42")).toBeInTheDocument();
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
    expect(screen.queryByText("Gold Reserve")).not.toBeInTheDocument();
  });

  it("shows only commodity assets when type=commodity is in the URL", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] }, "type=commodity");
    render(<AssetExplorer />);

    expect(screen.getByText("Gold Reserve")).toBeInTheDocument();
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
    expect(screen.queryByText("Trade Invoice #42")).not.toBeInTheDocument();
  });

  it("ignores an invalid type param and shows all assets", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET] }, "type=invalid_type");
    render(<AssetExplorer />);

    // Invalid type falls back to 'all'
    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.getByText("Trade Invoice #42")).toBeInTheDocument();
  });

  // ── bond / equity / fund (types the registry accepts) ──────────────────

  const BOND_ASSET = makeAsset({ id: 4n, name: "Lagos Treasury Bond", assetType: "bond" });
  const EQUITY_ASSET = makeAsset({ id: 5n, name: "Nairobi Growth Equity", assetType: "equity" });
  const FUND_ASSET = makeAsset({ id: 6n, name: "Accra Income Fund", assetType: "fund" });
  const ALL_TYPE_ASSETS = [
    REAL_ESTATE_ASSET,
    INVOICE_ASSET,
    COMMODITY_ASSET,
    BOND_ASSET,
    EQUITY_ASSET,
    FUND_ASSET,
  ];

  it.each([
    ["bond", "Lagos Treasury Bond"],
    ["equity", "Nairobi Growth Equity"],
    ["fund", "Accra Income Fund"],
  ])("accepts type=%s in the URL and shows only those assets", (type, name) => {
    setupMock({ assets: ALL_TYPE_ASSETS }, `type=${type}`);
    render(<AssetExplorer />);

    expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    // The matching chip is the pressed one, so the URL param was honoured
    // rather than coerced back to "all".
    expect(screen.getByRole("button", { pressed: true })).toHaveAccessibleName(
      new RegExp(`^${type}, 1 asset$`, "i"),
    );
  });

  it("pushes type=bond to the URL when the Bond chip is clicked", () => {
    jest.useFakeTimers();
    setupMock({ assets: ALL_TYPE_ASSETS });
    render(<AssetExplorer />);

    fireEvent.click(screen.getByRole("button", { name: /^bond/i }));
    jest.advanceTimersByTime(300);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0]).toContain("type=bond");
    jest.useRealTimers();
  });

  it("per-type chip counts add up to the All count", () => {
    // Two invoices so the counts are not all 1.
    const secondInvoice = makeAsset({ id: 7n, name: "Trade Invoice #43", assetType: "invoice" });
    setupMock({ assets: [...ALL_TYPE_ASSETS, secondInvoice] });
    render(<AssetExplorer />);

    const group = screen.getByRole("group", { name: /filter by asset type/i });
    const counts = Array.from(group.querySelectorAll("button")).map((b) => {
      const match = /, (\d+) assets?$/.exec(b.getAttribute("aria-label") ?? "");
      return Number(match?.[1]);
    });
    const [all, ...perType] = counts;
    expect(all).toBe(7);
    expect(perType).toEqual([1, 2, 1, 1, 1, 1]);
    expect(perType.reduce((sum, n) => sum + n, 0)).toBe(all);
  });

  // ── filter chip interactions push to router ────────────────────────────

  it("calls router.push with type param when a filter chip is clicked", () => {
    jest.useFakeTimers();
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] });
    render(<AssetExplorer />);

    const realEstateChip = screen.getByRole("button", { name: /real estate/i });
    fireEvent.click(realEstateChip);
    jest.advanceTimersByTime(300);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url: string = mockPush.mock.calls[0][0];
    expect(url).toContain("type=real_estate");
    jest.useRealTimers();
  });

  it("calls router.push without type param when 'All Assets' chip is clicked", () => {
    jest.useFakeTimers();
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET] }, "type=invoice");
    render(<AssetExplorer />);

    fireEvent.click(screen.getByRole("button", { name: /all assets/i }));
    jest.advanceTimersByTime(300);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url: string = mockPush.mock.calls[0][0];
    // 'all' should not add a type param (clean URL)
    expect(url).not.toContain("type=");
    jest.useRealTimers();
  });

  // ── type filtering ─────────────────────────────────────────────────────

  it("filters the list to only real-estate assets when that chip is clicked", () => {
    // Re-render with the new searchParams to simulate navigation
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] }, "type=real_estate");
    render(<AssetExplorer />);

    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.queryByText("Trade Invoice #42")).not.toBeInTheDocument();
    expect(screen.queryByText("Gold Reserve")).not.toBeInTheDocument();
  });

  it("filters the list to only invoice assets when the invoice chip is clicked", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] }, "type=invoice");
    render(<AssetExplorer />);

    expect(screen.getByText("Trade Invoice #42")).toBeInTheDocument();
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
    expect(screen.queryByText("Gold Reserve")).not.toBeInTheDocument();
  });

  it("filters the list to only commodity assets when the commodity chip is clicked", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] }, "type=commodity");
    render(<AssetExplorer />);

    expect(screen.getByText("Gold Reserve")).toBeInTheDocument();
    expect(screen.queryByText("Lagos Office Tower")).not.toBeInTheDocument();
    expect(screen.queryByText("Trade Invoice #42")).not.toBeInTheDocument();
  });

  it("restores all assets when 'All Assets' chip is clicked after filtering", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] });
    render(<AssetExplorer />);

    // All assets visible (no filter in URL)
    expect(screen.getByText("Lagos Office Tower")).toBeInTheDocument();
    expect(screen.getByText("Trade Invoice #42")).toBeInTheDocument();
    expect(screen.getByText("Gold Reserve")).toBeInTheDocument();
  });

  // ── pagination ─────────────────────────────────────────────────────────

  it("does not render pagination controls when there are 9 or fewer assets", () => {
    setupMock({ assets: [REAL_ESTATE_ASSET, INVOICE_ASSET, COMMODITY_ASSET] });
    render(<AssetExplorer />);

    expect(screen.queryByRole("navigation", { name: /pagination/i })).not.toBeInTheDocument();
  });

  it("renders pagination controls and shows page 1 of 2 when there are more than 9 assets", () => {
    const manyAssets = Array.from({ length: 11 }, (_, i) =>
      makeAsset({ id: BigInt(i + 1), name: `Asset ${i + 1}` }),
    );
    setupMock({ assets: manyAssets });
    render(<AssetExplorer />);

    const nav = screen.getByRole("navigation", { name: /pagination/i });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument();
  });

  it("shows page 2 content when page=2 is in the URL", () => {
    const manyAssets = Array.from({ length: 11 }, (_, i) =>
      makeAsset({ id: BigInt(i + 1), name: `Asset ${i + 1}` }),
    );
    setupMock({ assets: manyAssets }, "page=2");
    render(<AssetExplorer />);

    // Page 2: assets 10 and 11 visible
    expect(screen.getByText("Asset 10")).toBeInTheDocument();
    expect(screen.getByText("Asset 11")).toBeInTheDocument();
    expect(screen.queryByText("Asset 1")).not.toBeInTheDocument();
  });

  it("calls router.push with the next page when the next-page button is clicked", () => {
    const manyAssets = Array.from({ length: 11 }, (_, i) =>
      makeAsset({ id: BigInt(i + 1), name: `Asset ${i + 1}` }),
    );
    setupMock({ assets: manyAssets });
    render(<AssetExplorer />);

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url: string = mockPush.mock.calls[0][0];
    expect(url).toContain("page=2");
  });

  it("resets to page 1 when a filter chip is clicked", () => {
    jest.useFakeTimers();
    const manyRealEstate = Array.from({ length: 10 }, (_, i) =>
      makeAsset({
        id: BigInt(i + 1),
        name: `RE Asset ${i + 1}`,
        assetType: "real_estate",
      }),
    );
    // Start on page 2
    setupMock({ assets: manyRealEstate }, "page=2");
    render(<AssetExplorer />);

    // Apply filter — should call router.push without a page param (resets to 1)
    fireEvent.click(screen.getByRole("button", { name: /real estate/i }));
    jest.advanceTimersByTime(300);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url: string = mockPush.mock.calls[0][0];
    expect(url).not.toContain("page=");
    expect(url).toContain("type=real_estate");
    jest.useRealTimers();
  });
});
