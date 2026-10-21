/**
 * Client-side checks that mirror what the contracts enforce, so bad input is
 * rejected before the wallet is asked to sign.
 */

/** User-facing description of a valid jurisdiction code. */
export const JURISDICTION_HINT = "2-letter ISO 3166-1 alpha-2 code (e.g. US, DE, KE)";

export const JURISDICTION_ERROR = `Enter a ${JURISDICTION_HINT}.`;

/**
 * `maxLength` for jurisdiction inputs. Deliberately one more than the 2-letter
 * code: capping at 2 would silently truncate an alpha-3 code into a different,
 * valid country ("CHN" -> "CH", Switzerland) and clip a pasted leading space.
 * With room for a third character the input shows what was typed and
 * `isValidJurisdiction` rejects it with a message instead.
 */
export const JURISDICTION_INPUT_MAX_LENGTH = 3;

/** The form sent on-chain: trimmed and upper-cased ("us" -> "US"). */
export function normalizeJurisdiction(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Whether `code` is a jurisdiction the compliance contract will accept: exactly
 * two ASCII letters after trimming (its `normalize_jurisdiction` rejects
 * anything else with `InvalidJurisdiction`). Case is ignored; use
 * `normalizeJurisdiction` for the value to send.
 *
 * The contract also strips *inner* spaces, so it would turn "U S" into "US".
 * We deliberately reject that here: no real ISO code contains a space, so it is
 * a typo, and the stored value would differ from what the issuer typed.
 */
export function isValidJurisdiction(code: string): boolean {
  return /^[A-Za-z]{2}$/.test(code.trim());
}
