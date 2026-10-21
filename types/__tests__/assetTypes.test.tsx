/**
 * Drift guard for the asset-type lists.
 *
 * The registry contract rejects any asset type outside its VALID_ASSET_TYPES,
 * and several places in the UI keep their own per-type data (labels, badge
 * styles, filter chips, wizard options). This test fails when a type is added
 * to or removed from one of them without the others:
 *   - REGISTRY_TYPES below mirrors VALID_ASSET_TYPES in stellar-rwa-contracts
 *     (contracts/registry/src/lib.rs); update it together with ASSET_TYPES.
 *   - labels, badge styles, the Explore filter chips and the tokenize wizard
 *     must each cover exactly the types in ASSET_TYPES.
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ASSET_TYPES, ASSET_TYPE_LABELS } from "@/types";
import { assetTypeLabel } from "@/lib/format";
import { AssetTypeBadge } from "@/components/asset/AssetTypeBadge";
import { AssetFilter } from "@/components/asset/AssetFilter";
import { Step2AssetDetails } from "@/components/tokenize/Step2AssetDetails";

jest.mock("@/components/tokenize/Step1TokenContract", () => ({
  TokenContractPreview: () => <div>Token contract preview</div>,
}));

/** Mirror of the registry contract's VALID_ASSET_TYPES. */
const REGISTRY_TYPES = ["real_estate", "invoice", "commodity", "bond", "equity", "fund"];

const sorted = (list: readonly string[]) => [...list].sort();

describe("asset type lists", () => {
  it("ASSET_TYPES matches the types the registry contract accepts", () => {
    expect(sorted(ASSET_TYPES)).toEqual(sorted(REGISTRY_TYPES));
  });

  it("has no duplicate entries", () => {
    expect(new Set(ASSET_TYPES).size).toBe(ASSET_TYPES.length);
  });

  it("ASSET_TYPE_LABELS has a distinct label for exactly the types in ASSET_TYPES", () => {
    expect(sorted(Object.keys(ASSET_TYPE_LABELS))).toEqual(sorted(ASSET_TYPES));
    const labels = Object.values(ASSET_TYPE_LABELS);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("assetTypeLabel resolves every type to its label", () => {
    for (const t of ASSET_TYPES) {
      expect(assetTypeLabel(t)).toBe(ASSET_TYPE_LABELS[t]);
    }
  });

  it("every type has its own badge styling rather than the neutral fallback", () => {
    // The fallback badge is what an unrecognised type gets.
    render(<AssetTypeBadge type="not_a_real_type" />);
    const fallbackClasses = screen.getByText("Not A Real Type").className;

    const seen = new Map<string, string>();
    for (const t of ASSET_TYPES) {
      const { unmount } = render(<AssetTypeBadge type={t} />);
      const badge = screen.getByText(ASSET_TYPE_LABELS[t]);
      expect(badge.className).not.toBe(fallbackClasses);
      expect(badge.querySelector("svg")).not.toBeNull();
      // Distinct colour per type: no two types may share a class string.
      const clash = seen.get(badge.className);
      expect(clash).toBeUndefined();
      seen.set(badge.className, t);
      unmount();
    }
  });

  it("the Explore filter offers a chip for every type, plus All", () => {
    render(
      <AssetFilter
        value={{ type: "all", sort: "valuation" }}
        onChange={jest.fn()}
        search=""
        onSearchChange={jest.fn()}
      />,
    );
    const group = screen.getByRole("group", { name: /filter by asset type/i });
    const chipLabels = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
    expect(chipLabels).toEqual(["All Assets", ...ASSET_TYPES.map((t) => ASSET_TYPE_LABELS[t])]);
  });

  describe("tokenize wizard (Step 2)", () => {
    const validated = {
      tokenContract: "CABC123456789",
      metadata: {
        name: "On-chain asset",
        symbol: "AST",
        assetType: "real_estate",
        totalSupply: 1_000_000n,
        decimals: 2,
        admin: "GADMIN123456789",
        complianceContract: "CCOMPLIANCE123456",
        assetDescription: "",
        valuation: 100_000_00n,
        paused: false,
      },
    };

    function renderStep() {
      const onNext = jest.fn();
      render(
        <Step2AssetDetails validated={validated} initial={{}} onBack={jest.fn()} onNext={onNext} />,
      );
      return { onNext };
    }

    it("offers an option for every type", () => {
      renderStep();
      const group = screen.getByRole("group", { name: "Asset class" });
      const options = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
      expect(options).toEqual(ASSET_TYPES.map((t) => ASSET_TYPE_LABELS[t]));
    });

    it.each(ASSET_TYPES.map((t) => [t]))("submits %s when it is selected", (type) => {
      const { onNext } = renderStep();
      fireEvent.change(screen.getByRole("textbox", { name: "Valuation (USD)" }), {
        target: { value: "1000" },
      });
      fireEvent.click(screen.getByRole("button", { name: ASSET_TYPE_LABELS[type] }));
      fireEvent.click(screen.getByRole("button", { name: /review/i }));

      expect(onNext).toHaveBeenCalledWith({
        name: "On-chain asset",
        assetType: type,
        valuation: 100_000n,
      });
    });
  });
});
