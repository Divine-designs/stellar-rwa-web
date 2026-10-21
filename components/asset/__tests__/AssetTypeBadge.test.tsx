/**
 * Tests for components/asset/AssetTypeBadge.tsx
 *
 * Strategy: render the badge for each known asset type (real_estate / invoice /
 * commodity / bond / equity / fund) and assert the human label plus the colour
 * classes from STYLES.
 * Also covers the fallback path for an unrecognised type and className forwarding.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { AssetTypeBadge } from "../AssetTypeBadge";

describe("AssetTypeBadge", () => {
  it("renders the Real Estate label with its colour classes and icon", () => {
    render(<AssetTypeBadge type="real_estate" />);
    const badge = screen.getByText("Real Estate");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("bg-sky-500/10", "text-sky-300");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("renders the Invoice label with its colour classes and icon", () => {
    render(<AssetTypeBadge type="invoice" />);
    const badge = screen.getByText("Invoice");
    expect(badge).toHaveClass("bg-violet-500/10", "text-violet-300");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("renders the Commodity label with its colour classes and icon", () => {
    render(<AssetTypeBadge type="commodity" />);
    const badge = screen.getByText("Commodity");
    expect(badge).toHaveClass("bg-amber-500/10", "text-amber-300");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("renders the Bond label with its colour classes and icon", () => {
    render(<AssetTypeBadge type="bond" />);
    const badge = screen.getByText("Bond");
    expect(badge).toHaveClass("bg-emerald-500/10", "text-emerald-300");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("renders the Equity label with its colour classes and icon", () => {
    render(<AssetTypeBadge type="equity" />);
    const badge = screen.getByText("Equity");
    expect(badge).toHaveClass("bg-rose-500/10", "text-rose-300");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("renders the Fund label with its colour classes and icon", () => {
    render(<AssetTypeBadge type="fund" />);
    const badge = screen.getByText("Fund");
    expect(badge).toHaveClass("bg-cyan-500/10", "text-cyan-300");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("falls back to a neutral style and a title-cased label for unknown types", () => {
    render(<AssetTypeBadge type="some_new_type" />);
    const badge = screen.getByText("Some New Type");
    expect(badge).toHaveClass("bg-white/5", "border-white/10", "text-base-100/60");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("forwards an extra className alongside the badge classes", () => {
    render(<AssetTypeBadge type="real_estate" className="ml-2" />);
    const badge = screen.getByText("Real Estate");
    expect(badge).toHaveClass("ml-2");
  });
});
