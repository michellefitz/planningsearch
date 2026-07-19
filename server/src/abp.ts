/**
 * An Coimisiún Pleanála (formerly An Bord Pleanála) appeal-case deep links.
 *
 * The national planning dataset carries an appeal reference (AppealRefNumber)
 * in several historical forms — ABP-319506-23, ACP-301000-21, PL29N.301702,
 * TR17.310928, or a bare 319506. In every one the operative case number is the
 * six-digit group, which is what ACP's public case search keys on; the case
 * file (pending or decided) lives at a stable per-case URL. Wiring that link
 * closes the loop from a council decision to the national appeal outcome.
 */
export const ACP_CASE_BASE = "https://www.pleanala.ie/en-ie/case";

/**
 * Pull the six-digit ACP/ABP case number out of any appeal-reference form.
 * Returns null for references with no six-digit group (some pre-2015 legacy
 * refs), which simply get no deep link rather than a broken one.
 */
export function abpCaseNumber(reference: string | null | undefined): string | null {
  if (!reference) return null;
  const m = reference.match(/\d{6}/);
  return m ? m[0] : null;
}

/** Deep link to the An Coimisiún Pleanála case file, or null if unparseable. */
export function abpCaseUrl(reference: string | null | undefined): string | null {
  const num = abpCaseNumber(reference);
  return num ? `${ACP_CASE_BASE}/${num}` : null;
}
