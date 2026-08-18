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

export const FURTHER_INFO_PROMPT =
  "An Irish council has asked an applicant for further information before it will decide their " +
  "planning application. You are given the request. Say what the applicant has to do.\n\n" +
  "Write 2 to 4 short sentences of plain English for a regular person, not a planner. Lead with " +
  "the changes to the building or the site — something to be moved, omitted, resized, redesigned " +
  "or justified — because those are what decide whether the scheme survives. Put the paperwork " +
  "(surveys, test results, reports, drawings to be resubmitted) after them, grouped, not itemised " +
  "one by one.\n\n" +
  "Quote a figure, a material or a standard only where the council named one. Never cite a policy, " +
  "a plan section or a guideline number — say what it requires instead. Do not mention condition " +
  "or item numbers.\n\n" +
  "If the request also signals a concern the council has not yet resolved — that an element may " +
  "not be acceptable at all, or that it could be read as a separate dwelling — say so plainly in " +
  "one clause, since that is the real risk to the application.\n\n" +
  "FORMAT: plain prose only. No Markdown, headings, bullet points or a title. Begin directly with " +
  "what is being asked for; do not restate the address or the reference. Use only what the request " +
  "states — never invent a requirement.";

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
  const raw = await callClaude(FURTHER_INFO_PROMPT, furtherInfoUserMsg(asked), 400, 30000);
  const text = String(raw ?? "").trim();
  if (!text || text.length < 20) return null;
  // Belt and braces for the odd time the model still reaches for Markdown.
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
