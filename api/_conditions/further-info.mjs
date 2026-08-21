/**
 * "What has the council actually asked for?"
 *
 * An application at the further-information stage is not undecided in the
 * sense of nothing having happened — the council has read it, formed a view,
 * and written down what it needs before it will decide. That request is the
 * most useful thing on the file at that moment: it tells the applicant what to
 * fix, the neighbours what the council is worried about, and anyone watching
 * the site which way it is leaning.
 *
 * The registers already carry it. On the agile portals the request arrives as
 * conditions coded "D" (Directive — the items being asked for) and "I"
 * (Informative — the reasoning attached to them). SD25A/0308W, for instance,
 * carries three directives and two informatives running to several thousand
 * words of planning prose: percolation tests to BRE Digest 365, a written
 * justification for a family flat, revised plans omitting a second front door.
 * Nobody reads that to find out they need to move a door.
 */

/** The items that make up a request for further information. */
export function furtherInfoItems(items) {
  return (items ?? []).filter(
    (i) => (i?.code === "D" || i?.code === "I") && String(i.text ?? "").trim()
  );
}

/** Same cap as the conditions summariser: p99 of these is far below it. */
const MAX_CHARS = 24000;

export function furtherInfoUserMsg(items) {
  return items
    .map((c, i) => {
      const kind = c.code === "D" ? "Requirement" : "Note";
      const title = String(c.title ?? "").trim();
      return `--- ${kind} ${c.order || i + 1}${title ? `: ${title}` : ""} ---\n${c.text}`;
    })
    .join("\n\n")
    .slice(0, MAX_CHARS);
}

/**
 * Pick the council's further-information request out of a scanned file list.
 *
 * The eplanning councils (Kildare, Wicklow, Meath) publish no structured
 * conditions at all — the request is a letter in the document list, titled
 * "F.I. Request Letter", "Further Information Request" or some near variant.
 * Returns -1 when the file list holds none, so the sheet can say the request
 * is on file at the council rather than invent a summary.
 *
 * A file list is a running record, so most of what mentions further
 * information is not the request: Kildare 25189 carries 103 documents, of
 * which two are requests and roughly thirty are the applicant's answers, plus
 * acknowledgements, publication requests and re-advertisement notices. Each of
 * those describes something other than what the council asked for.
 */
const FI_DOC_RE =
  /\bf\.?\s?i\.?\b|further\s+information|additional\s+information|clarification/i;
/** A response from the applicant, or an acknowledgement of one, is not the
 *  request — reading it would summarise the answer as though it were the ask. */
const FI_NOT_REQUEST_RE =
  /received|response|reply|submitted|acknowledg|receipt|checklist|extension of time/i;
/** Nor is a direction to re-advertise: "F.I. Publication Request Letter" and
 *  the notices that follow it are about the newspaper and the site notice, not
 *  about the development. */
const FI_NOTICE_RE = /publication|news\s?paper|newspaper|site notice|advertis/i;
/**
 * Nor is the copy the post brought back.
 *
 * Meath files undelivered mail beside the original under the same document
 * type — 212214 carries "F.I. Request Letter — Returned Post-Gone Away" next
 * to "F.I. Request Letter — Further Information", and does the same with its
 * decision letters ("Decision Documentation Returned") and its
 * acknowledgements. It scored identically to the real letter and, being filed
 * after it, won the tie-break meant for a second round of questions. The
 * summary was read out of an envelope that never reached the applicant.
 */
export const RETURNED_POST_RE = /returned|gone[\s-]?away|undelivered|not\s+called\s+for/i;

/**
 * The council's internal authority to ask, rather than the asking.
 *
 * A Chief Executive's Order directs that further information be sought; the
 * letter is what goes to the applicant and says what is wanted. Both are filed
 * as "F.I. Request Letter" on Meath, so without this the choice between them
 * rests on which the register happened to append last.
 */
const INTERNAL_ORDER_RE = /chief executive|executive'?s? order|manager'?s? order|\border\b/i;

/**
 * Bumped when the rules above change which document gets read.
 *
 * The cached summary is keyed on the prompt, which is right while the prompt
 * is the only thing that shapes the answer — it is not. A summary read out of
 * the wrong document does not stop being wrong because the prompt stayed the
 * same, and Meath 212214's was cached from a returned envelope. Folded into
 * the cache kind so a change here retires the answers it invalidates.
 *
 * 2 — returned post excluded, and the letter preferred to the order that
 *     authorised it.
 */
export const FI_SELECTION_VERSION = 2;

export function findFurtherInfoDocIndex(files) {
  let best = -1;
  let bestScore = 0;
  (files ?? []).forEach((f, i) => {
    const t = String(f?.title ?? "");
    if (!FI_DOC_RE.test(t) || FI_NOT_REQUEST_RE.test(t) || FI_NOTICE_RE.test(t)) return;
    if (RETURNED_POST_RE.test(t)) return;
    let score = 1;
    if (/request/i.test(t)) score += 3;
    if (/letter/i.test(t)) score += 1;
    // Names the thing itself, not the order authorising it. Enough to settle a
    // tie between two documents the council filed under the same type.
    if (/further\s+information/i.test(t)) score += 2;
    if (INTERNAL_ORDER_RE.test(t)) score -= 2;
    // A penalty ranks a document below its siblings; it never rules one out.
    // Some councils file only the order, and the order does carry what was
    // asked for — better to read it than to tell the reader there is nothing.
    score = Math.max(1, score);
    // >= so a later entry wins a tie: registers append chronologically, and an
    // application can go round twice — Kildare 25189 was asked in December and
    // again in June. The operative request is the most recent one.
    if (score >= bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * How long a summary may run.
 *
 * A further-information request is long by nature — Kildare 25189's covers
 * trees, open space, cycle crossings, a road-safety audit, drainage and
 * attenuation across several pages — and asked to summarise it the model
 * happily produced 400 words, which is a rewrite rather than a summary and is
 * worse than the letter because it reads as though every clause matters
 * equally. The letter is one tap away underneath; this is the orientation.
 */
// 85, not 70: three sentences of ordinary length fit inside it, so the trim
// stays a backstop against a runaway rather than a guillotine on a good
// summary that happens to end with a long clause.
const MAX_WORDS = 85;

export const FURTHER_INFO_PROMPT =
  "An Irish council has asked an applicant for further information before it will decide their " +
  "planning application. You are given the request. Say what it is about, briefly.\n\n" +
  `HARD LIMIT: ${MAX_WORDS} words, in at most three sentences. This is an orientation, not a ` +
  "reproduction — the request itself is one tap away, and a reader who wants every clause will " +
  "open it. Going over the limit makes the summary useless.\n\n" +
  "To stay inside it, name themes rather than items. \"Revised drawings for pedestrian and cyclist " +
  "access, and a road-safety audit\" — not each drawing. \"Surface-water design\" — not attenuation " +
  "volumes, discharge rates and percolation tests separately. Six requirements about drainage are " +
  "one theme.\n\n" +
  "Lead with what the council wants changed about the building or the site — something moved, " +
  "omitted, resized, redesigned or kept — because that is what decides whether the scheme " +
  "survives. Then, in a single clause, the reports and drawings wanted, grouped. If the council " +
  "has signalled that an element may not be acceptable at all, say so: that is the real risk.\n\n" +
  "Quote a figure or a material only where it is the point of the requirement. Never cite a " +
  "policy, a plan section, a guideline, or tree, condition or item numbers.\n\n" +
  "FORMAT: plain prose, plain English, for a regular person rather than a planner. No Markdown, " +
  "headings, bullets or a title. Begin with what is being asked for; do not restate the address " +
  "or the reference. Use only what the request states — never invent a requirement.";

/**
 * Everything the model returns after the word budget is spent, dropped.
 *
 * The prompt asks for brevity and mostly gets it, but "mostly" is not a
 * guarantee and the failure is the one the reader sees. Cutting at a sentence
 * boundary keeps it readable, and cutting from the end keeps what matters: the
 * prompt puts the physical changes first and the paperwork last, so the part
 * that survives is the part that decides the application.
 */
export function trimToSummary(text, maxWords = MAX_WORDS) {
  // Split on sentence-ending punctuation, but not on the abbreviations these
  // letters are full of — "Hedge No. 1, Tree Nos. 12, 13" is one sentence.
  const parts = String(text)
    .replace(/\b(No|Nos|Fig|Figs|Approx|St|Rd|Ave|Dr|Ltd|etc|i\.e|e\.g)\.\s/gi, "$1\u0000 ")
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.replace(/\u0000/g, "."));
  const out = [];
  let words = 0;
  for (const part of parts) {
    const n = part.trim().split(/\s+/).filter(Boolean).length;
    // Always keep the first sentence, however long — a truncated one still
    // says more than nothing.
    if (out.length && words + n > maxWords) break;
    out.push(part.trim());
    words += n;
  }
  return out.join(" ").trim();
}

/**
 * Plain-English summary of a further-information request. `callClaude(system,
 * content, maxTokens, timeoutMs)` is injected so the serverless entry and the
 * dev server each pass their own. Returns null when there is nothing to read
 * or the model call failed — which the UI must show differently from a request
 * that carried no items.
 */
export async function furtherInfoSummary(items, callClaude) {
  const asked = furtherInfoItems(items);
  if (!asked.length) return null;
  // Tokens sized to the word budget rather than to the request: a cap the
  // model can comfortably reach is a cap it will reach.
  const raw = await callClaude(FURTHER_INFO_PROMPT, furtherInfoUserMsg(asked), 220, 30000);
  return cleanSummary(raw);
}

/** Markdown stripped, then cut to the word budget. Null when there is nothing
 *  usable — which the UI shows differently from a request with no items. */
export function cleanSummary(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length < 20) return null;
  // Belt and braces for the odd time the model still reaches for Markdown.
  const plain = text
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return trimToSummary(plain) || null;
}
