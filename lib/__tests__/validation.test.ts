import {
  JURISDICTION_ERROR,
  isValidJurisdiction,
  normalizeJurisdiction,
} from "@/lib/validation";

// The compliance contract's normalize_jurisdiction accepts exactly two ASCII
// letters (after stripping spaces and upper-casing) and rejects the rest with
// InvalidJurisdiction. The client must reject the same inputs up front.

describe("isValidJurisdiction", () => {
  it.each(["US", "DE", "KE", "us", "uS"])("accepts the two-letter code %j", (code) => {
    expect(isValidJurisdiction(code)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isValidJurisdiction(" US ")).toBe(true);
    expect(isValidJurisdiction("\tke\n")).toBe(true);
  });

  it.each([
    ["USA", "three letters (alpha-3)"],
    ["U1", "a digit"],
    ["12", "digits only"],
    ["U", "a single character"],
    ["", "empty input"],
    ["   ", "blank input"],
    ["U-", "punctuation"],
    ["ÜS", "a non-ASCII letter"],
  ])("rejects %j (%s)", (code) => {
    expect(isValidJurisdiction(code)).toBe(false);
  });

  // Decision: inner spaces are rejected. The contract would strip them
  // ("U S" -> "US"), but no real ISO code has a space, so it is a typo and the
  // stored value would silently differ from what the issuer typed.
  it("rejects inner spaces even though the contract would strip them", () => {
    expect(isValidJurisdiction("U S")).toBe(false);
    expect(isValidJurisdiction(" U S ")).toBe(false);
  });
});

describe("normalizeJurisdiction", () => {
  it("upper-cases and trims", () => {
    expect(normalizeJurisdiction("us")).toBe("US");
    expect(normalizeJurisdiction("  de ")).toBe("DE");
  });

  it("leaves an already-normal code unchanged", () => {
    expect(normalizeJurisdiction("KE")).toBe("KE");
  });
});

describe("JURISDICTION_ERROR", () => {
  it("describes the two-letter alpha-2 rule, not the old 2-3 character one", () => {
    expect(JURISDICTION_ERROR).toBe(
      "Enter a 2-letter ISO 3166-1 alpha-2 code (e.g. US, DE, KE).",
    );
  });
});
