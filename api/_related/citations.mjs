/**
 * The applications an application names in its own description.
 *
 * Councils write the history into the text: "modifications to previously
 * granted development, planning ref. no. 2965/15 (ABP PL29N.245656) and
 * extended by 2965/15/x2". Address matching never finds those — 2965/15 is
 * from 2015, four years before the national dataset's Dublin City records
 * begin, and 2965/15/X2 is an extension of duration, a type Dublin City does
 * not publish nationally at all. Both are invisible to us; both are named in
 * the sentence we already hold.
 *
 * Sampled 270 applications at random: 5% cite another reference. Of those
 * citations, half pointed at applications already in our register that the
 * address match had missed, so this is not only about old data.
 *
 * WHY THE FORMAT MATTERS. A generic "digits, slash, digits" rule reads
 * "Directive (EU) 2023/2413" — the RED III directive — as a planning
 * reference, which it did on seven unrelated solar farms before this was
 * written. A candidate only counts if it looks like a reference the council in
 * question actually issues, and for the councils whose references are bare
 * digits it must also follow an explicit cue, because a seven-digit number in
 * prose is otherwise indistinguishable from any other number.
 */

/**
 * What a reference looks like, per council, derived from the registers
 * themselves (the shape of 300 live references each).
 *
 * Suffixes are part of the reference, not noise: /X2 is an extension of
 * duration, Sub01 a compliance submission, /C11 a condition compliance. They
 * name different records and must not be trimmed to the stem.
 */
const FORMATS = {
  "dublin-city": /(?:[A-Z]{2,8})?\d{4}\/\d{2}(?:\/[A-Z]{1,2}\d?|Sub\d{2})?/gi,
  dlr: /D\d{2}[A-Z]\/\d{4}(?:\/[A-Z]{1,3}\d?)?/gi,
  fingal: /[A-Z]{1,3}\d{2}[A-Z]\/\d{4}[A-Z]?/gi,
  "south-dublin": /SD\d{2}[A-Z]?\/\d{4}[A-Z]?/gi,
  // Longest alternative first, always. Written the other way round, a council
  // whose references are five or seven digits reads the six-digit "211434" as
  // "21143" and cites an application that is not the one named.
  "cork-county": /\d{2}\/\d{5}|\d{2}\/\d{4}/g,
  "cork-city": /\d{7}/g,
  wexford: /\d{8}/g,
  meath: /\d{7}|\d{5}/g,
  wicklow: /\d{7}|\d{5}/g,
  kildare: /\d{7}|\d{5}|\d{4}/g,
};

/**
 * Councils whose references are bare digits, where a match means nothing on
 * its own. "4 no. 3-bed" and "circa 137 hectares" are full of numbers.
 */
const CUE_ONLY = new Set(["cork-city", "wexford", "meath", "wicklow", "kildare", "cork-county"]);

/** The phrases councils use before naming a previous application. */
const CUE =
  /(?:reg(?:\.|ister)?\.?\s*ref(?:\.|erence)?|planning\s+(?:reg(?:ister)?\.?\s*)?ref(?:\.|erence)?|p\.?\s?a\.?\s*ref|application\s+(?:no|number)|file\s+ref|permitted\s+under|granted\s+under|approved\s+under|extended\s+by|under\s+ref)\.?\s*(?:no\.?)?\s*:?\s*/gi;

/**
 * An Bord Pleanála / An Coimisiún Pleanála case references, in both the old
 * and current forms. Worth catching separately: the appeal is often where the
 * decision that actually governs the site was made.
 */
const APPEAL = /(?:PL\d{1,2}[A-Z]?\.\d{5,6}|ABP-\d{6}-\d{2})/gi;

/** Only what the whole token is — never a reference-shaped slice of a longer
 *  number, which is how a directive number passes for a planning reference. */
function whole(text, match) {
  const before = text[match.index - 1];
  const after = text[match.index + match[0].length];
  return !(before && /[\w/]/.test(before)) && !(after && /[\w/]/.test(after));
}

/**
 * References named in this application's text, excluding its own.
 *
 * Returns `{ reference, kind }`, kind being "application" or "appeal".
 */
export function extractCitations(text, authorityId, ownReference = null) {
  const fmt = FORMATS[authorityId];
  if (!text || !fmt) return [];
  const found = new Map();
  const own = String(ownReference ?? "").toUpperCase();
  const add = (ref, kind) => {
    const key = ref.toUpperCase();
    if (!key || key === own || found.has(key)) return;
    found.set(key, { reference: ref, kind });
  };

  // Anchored: a cue phrase, then the reference immediately after it. The only
  // route available to the bare-digit councils.
  for (const cue of text.matchAll(CUE)) {
    const from = cue.index + cue[0].length;
    const tail = text.slice(from, from + 28);
    // The trailing guard matters as much as the cue. Without it the five-digit
    // alternative of a bare-digit format happily matches the first five digits
    // of a six-digit reference and reports a different application.
    const anchored = new RegExp(
      `^\\s*(?:no\\.?\\s*)?(?:${fmt.source})(?![\\w/])`,
      fmt.flags.replace("g", "")
    );
    const hit = tail.match(anchored);
    if (hit) add(hit[0].replace(/^\s*(?:no\.?\s*)?/i, "").trim(), "application");
  }

  // Distinctive formats can also stand alone: "as permitted by D98A/0886".
  if (!CUE_ONLY.has(authorityId)) {
    for (const m of text.matchAll(fmt)) if (whole(text, m)) add(m[0], "application");
  }
  for (const m of text.matchAll(APPEAL)) add(m[0], "appeal");
  return [...found.values()];
}

/** How references are compared: councils vary the case and the separators
 *  between the text and the register ("2965/15/x2" against "2965/15/X2"). */
export function referenceKey(reference) {
  return String(reference ?? "").toUpperCase().replace(/[\s.]/g, "");
}

/**
 * Where to send someone for a reference we do not hold.
 *
 * The agile councils' portals take a keyword, and their registers go back much
 * further than the national dataset does — Dublin City's holds 2965/15 from
 * 2015, four years before ours begins. The eplanning councils have no
 * constructible search URL, so they get their register's front page rather
 * than a link that would land on an error.
 */
export function citationPortalUrl(authority, reference) {
  // The bundle spells these snake_case and the server's config camelCase; both
  // describe the same council, so take either rather than adapting at each
  // call site.
  const base = authority?.portal_base_url ?? authority?.portalBaseUrl ?? null;
  const system = authority?.source_system ?? authority?.sourceSystem ?? null;
  if (!base || !reference) return null;
  if (system === "agile") {
    return `${base}/search-applications/?keyword=${encodeURIComponent(reference)}`;
  }
  return base;
}
