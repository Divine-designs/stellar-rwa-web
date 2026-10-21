/**
 * Tests for components/issuer/panels/CompliancePanel.tsx
 *
 * Focus (#322): AddToAllowlistCard's expiry-ledger input must reject ledger
 * numbers that are already in the past relative to the current on-chain ledger
 * (getLatestLedger), showing a clear warning instead of submitting a dead KYC
 * record. The existing NaN / negative validation must still work.
 *
 * Strategy: mock getLatestLedger to return a known current ledger so we can
 * test boundary values precisely, mock useTx so no Soroban calls happen, and
 * mock StrKey so any G… address passes validation.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AssetDetail } from "@/types";

// ── mock @stellar/stellar-sdk ─────────────────────────────────────────────

jest.mock("@stellar/stellar-sdk", () => ({
  ...jest.requireActual("@stellar/stellar-sdk"),
  StrKey: {
    isValidEd25519PublicKey: (addr: string) => addr.startsWith("G"),
    isValidContract: (addr: string) => addr.startsWith("C"),
  },
}));

// ── mock getLatestLedger ───────────────────────────────────────────────────

const mockGetLatestLedger = jest.fn<Promise<number>, unknown[]>();
const mockUseAllowlist = jest.fn();

jest.mock("@/lib/stellar", () => ({
  ...jest.requireActual("@/lib/stellar"),
  getLatestLedger: (...args: unknown[]) => mockGetLatestLedger(...args),
}));

// ── mock useWallet ────────────────────────────────────────────────────────

jest.mock("@/hooks/useWallet", () => ({
  useWallet: jest.fn(() => ({ address: "GTESTADDRESS", network: "testnet" })),
}));

// ── mock useCompliance (useAllowlist) ─────────────────────────────────────

jest.mock("@/hooks/useCompliance", () => ({
  useAllowlist: (...args: unknown[]) => mockUseAllowlist(...args),
}));

// ── mock useTx ─────────────────────────────────────────────────────────────

const mockRun = jest.fn();

jest.mock("@/hooks/useTx", () => ({
  useTx: jest.fn(() => ({
    phase: "idle",
    hash: null,
    error: null,
    pending: false,
    run: mockRun,
    reset: jest.fn(),
  })),
}));

// ── mock contracts ────────────────────────────────────────────────────────

jest.mock("@/lib/contracts", () => ({
  compliance: {
    addToAllowlist: jest.fn(),
    suspend: jest.fn(),
    remove: jest.fn(),
    blockJurisdiction: jest.fn(),
    unblockJurisdiction: jest.fn(),
  },
}));

// ── mock layout / UI sub-components ──────────────────────────────────────

jest.mock("@/components/issuer/ActionCard", () => ({
  ActionCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/components/ui/TxProgress", () => ({
  TxProgress: () => <div data-testid="tx-progress" />,
}));

jest.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

jest.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <h2>{title}</h2>
        <p>{description}</p>
        <button onClick={onConfirm}>{confirmLabel}</button>
      </div>
    ) : null,
}));

jest.mock("@/components/ui/CopyButton", () => ({
  CopyButton: () => null,
}));

jest.mock("@/components/compliance/ComplianceBadge", () => ({
  ComplianceBadge: () => null,
}));

// ── imports after mocks ────────────────────────────────────────────────────

import { CompliancePanel } from "../CompliancePanel";
import { compliance } from "@/lib/contracts";
import { JURISDICTION_ERROR } from "@/lib/validation";

// ── test fixtures ─────────────────────────────────────────────────────────

/** A ledger value that the mock will report as the current ledger. */
const CURRENT_LEDGER = 5_000_000;

function makeAsset(): AssetDetail {
  return {
    id: 1n,
    tokenContract: "CTOKEN123",
    issuer: "GISSUER123",
    name: "Test Asset",
    assetType: "real_estate",
    valuation: 1_000_000_00n,
    createdAt: 50000,
    active: true,
    metadata: {
      name: "Test Asset",
      symbol: "TST",
      assetType: "real_estate",
      totalSupply: 1_000_000n,
      decimals: 7,
      admin: "GISSUER123",
      complianceContract: "CCOMPLIANCE",
      assetDescription: "",
      valuation: 1_000_000_00n,
      paused: false,
    },
  };
}

/** Fill in required fields and submit the "Approve address" form. */
async function fillAndSubmit({
  address = "GVALID123456789",
  jurisdiction = "US",
  expiresAt = "",
}: {
  address?: string;
  jurisdiction?: string;
  expiresAt?: string;
} = {}) {
  // Use the specific IDs to target the AddToAllowlistCard fields
  // (the JurisdictionCard also has jurisdiction inputs in the same render tree).
  fireEvent.change(screen.getByLabelText(/^address$/i), {
    target: { value: address },
  });
  fireEvent.change(document.getElementById("kyc-jurisdiction")!, {
    target: { value: jurisdiction },
  });
  fireEvent.change(document.getElementById("kyc-expires")!, {
    target: { value: expiresAt },
  });
  fireEvent.click(screen.getByRole("button", { name: /approve address/i }));
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("CompliancePanel — AddToAllowlistCard expiry-ledger validation (#322)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAllowlist.mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: jest.fn(),
    });
    // Default: ledger fetch succeeds with a known current ledger.
    mockGetLatestLedger.mockResolvedValue(CURRENT_LEDGER);
  });

  // ── past-ledger rejection ─────────────────────────────────────────────

  it("shows an error when the entered ledger is exactly the current ledger", async () => {
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: String(CURRENT_LEDGER) });

    await waitFor(() => {
      expect(
        screen.getByText(/already in the past/i),
      ).toBeInTheDocument();
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("shows an error when the entered ledger is one below the current ledger", async () => {
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: String(CURRENT_LEDGER - 1) });

    await waitFor(() => {
      expect(
        screen.getByText(/already in the past/i),
      ).toBeInTheDocument();
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("shows an error mentioning the current ledger number in the message", async () => {
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: String(CURRENT_LEDGER - 100) });

    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`current ledger.*${CURRENT_LEDGER}`, "i")),
      ).toBeInTheDocument();
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("accepts a ledger exactly one ahead of the current ledger", async () => {
    mockRun.mockResolvedValue({ hash: "abc", returnValue: undefined });
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: String(CURRENT_LEDGER + 1) });

    await waitFor(() => {
      expect(screen.queryByText(/already in the past/i)).not.toBeInTheDocument();
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts a ledger well in the future", async () => {
    mockRun.mockResolvedValue({ hash: "abc", returnValue: undefined });
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: String(CURRENT_LEDGER + 100_000) });

    await waitFor(() => {
      expect(screen.queryByText(/already in the past/i)).not.toBeInTheDocument();
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });

  // ── 0 = never expires (skip ledger check) ────────────────────────────

  it("accepts 0 (never expires) without calling getLatestLedger", async () => {
    mockRun.mockResolvedValue({ hash: "abc", returnValue: undefined });
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: "0" });

    await waitFor(() => {
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
    expect(mockGetLatestLedger).not.toHaveBeenCalled();
  });

  it("accepts an empty expiry (treated as 0) without calling getLatestLedger", async () => {
    mockRun.mockResolvedValue({ hash: "abc", returnValue: undefined });
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: "" });

    await waitFor(() => {
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
    expect(mockGetLatestLedger).not.toHaveBeenCalled();
  });

  // ── pre-existing NaN / negative validation still works ────────────────

  it("shows an error for a non-numeric expiry string", async () => {
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: "abc" });

    await waitFor(() => {
      expect(
        screen.getByText(/non-negative integer/i),
      ).toBeInTheDocument();
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("shows an error for a negative expiry", async () => {
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ expiresAt: "-1" });

    await waitFor(() => {
      expect(
        screen.getByText(/non-negative integer/i),
      ).toBeInTheDocument();
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  // ── graceful degradation when ledger fetch fails ──────────────────────

  it("still submits when getLatestLedger throws (network unavailable)", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("RPC unavailable"));
    mockRun.mockResolvedValue({ hash: "abc", returnValue: undefined });
    render(<CompliancePanel asset={makeAsset()} />);
    // A future ledger that would normally pass, but ledger fetch fails.
    await fillAndSubmit({ expiresAt: String(CURRENT_LEDGER + 1_000) });

    await waitFor(() => {
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/already in the past/i)).not.toBeInTheDocument();
  });

  it("confirms removal with the full address and immediate transfer impact", async () => {
    const address = "G1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH";
    mockUseAllowlist.mockReturnValue({
      data: [{ address, status: "Approved", jurisdiction: "US" }],
      loading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockRun.mockResolvedValue({ hash: "abc" });

    render(<CompliancePanel asset={makeAsset()} />);
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(address);
    expect(dialog).toHaveTextContent(/immediately/i);
    expect(dialog).toHaveTextContent(/sending, or receiving/i);

    fireEvent.click(screen.getByRole("button", { name: /remove address/i }));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
  });
});

// ── jurisdiction code validation ──────────────────────────────────────────
//
// The compliance contract accepts exactly two ASCII letters and rejects
// anything else with InvalidJurisdiction. Both forms must reject bad codes
// before the wallet is asked to sign (tx.run is never reached), accept good
// ones, and send the normalised (trimmed, upper-case) code.

const INVALID_CODES: [string, string][] = [
  ["USA", "three letters"],
  ["U1", "a digit"],
  ["U", "a single character"],
  ["", "empty input"],
  ["U S", "an inner space"],
];

const VALID_CODES: [string, string][] = [
  ["US", "US"],
  ["us", "US"],
  [" de ", "DE"],
];

const ADDRESS = "GVALID123456789";

/** Run the callback handed to tx.run, which is what reaches the contract call. */
function runLastTxCallback() {
  const callback = mockRun.mock.calls[mockRun.mock.calls.length - 1]![0] as (ctx: unknown) => unknown;
  callback("ctx");
}

describe("CompliancePanel — jurisdiction code validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRun.mockResolvedValue(undefined);
    mockUseAllowlist.mockReturnValue({
      data: [],
      loading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockGetLatestLedger.mockResolvedValue(CURRENT_LEDGER);
  });

  describe("Approve address form", () => {
    it.each(INVALID_CODES)("rejects %j (%s) before signing", async (code) => {
      render(<CompliancePanel asset={makeAsset()} />);
      await fillAndSubmit({ address: ADDRESS, jurisdiction: code });

      expect(await screen.findByText(JURISDICTION_ERROR)).toBeInTheDocument();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it.each(VALID_CODES)("accepts %j and sends %j", async (code, expected) => {
      render(<CompliancePanel asset={makeAsset()} />);
      await fillAndSubmit({ address: ADDRESS, jurisdiction: code });

      await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(JURISDICTION_ERROR)).not.toBeInTheDocument();
      runLastTxCallback();
      expect(compliance.addToAllowlist).toHaveBeenCalledWith("ctx", "CCOMPLIANCE", ADDRESS, expected, 0);
    });
  });

  describe.each([
    ["Block", "block-jur", compliance.blockJurisdiction],
    ["Unblock", "unblock-jur", compliance.unblockJurisdiction],
  ] as const)("%s jurisdiction form", (buttonName, inputId, contractCall) => {
    function submit(code: string) {
      render(<CompliancePanel asset={makeAsset()} />);
      fireEvent.change(document.getElementById(inputId)!, { target: { value: code } });
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
    }

    it.each(INVALID_CODES)("rejects %j (%s) before signing", async (code) => {
      submit(code);

      expect(await screen.findByText(JURISDICTION_ERROR)).toBeInTheDocument();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it.each(VALID_CODES)("accepts %j and sends %j", async (code, expected) => {
      submit(code);

      await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(JURISDICTION_ERROR)).not.toBeInTheDocument();
      runLastTxCallback();
      expect(contractCall).toHaveBeenCalledWith("ctx", "CCOMPLIANCE", expected);
    });
  });

  it("no longer tells issuers that 3-character codes are valid", async () => {
    render(<CompliancePanel asset={makeAsset()} />);
    await fillAndSubmit({ address: ADDRESS, jurisdiction: "USA" });

    const message = await screen.findByText(JURISDICTION_ERROR);
    expect(message).toHaveTextContent("2-letter ISO 3166-1 alpha-2 code (e.g. US, DE, KE)");
    expect(document.body).not.toHaveTextContent(/2[–-]3 character/i);
  });
});
