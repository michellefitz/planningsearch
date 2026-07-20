const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 10_000;

// Shared to every prompt: the model must produce a summary or nothing at all —
// never a message addressed to the reader. The truncated/partial descriptions
// the national dataset sometimes carries otherwise draw a conversational "I
// don't have enough information…" reply, which must never reach the UI.
const NO_LEAK_RULE =
  `Output only the summary itself — never address the reader, never ask a question, never mention ` +
  `that information is missing or incomplete, never refer to yourself. If the material does not ` +
  `contain enough to write the summary, reply with exactly this single word and nothing else: INSUFFICIENT`;

const DESCRIPTION_PROMPT =
  `You summarise Irish planning applications in one short sentence of plain English. ` +
  `The reader is a regular person, not a planner or architect. ` +
  `Say what the project actually is: an extension, a new house, a commercial unit, solar panels, etc. ` +
  `Include key details like number of bedrooms or storeys only when stated. ` +
  `Never start with "This application is for". Just state what it is. ` +
  `Keep it under 30 words. ` +
  NO_LEAK_RULE;

const REFUSAL_PROMPT =
  `You explain why an Irish council refused a planning application, in one short sentence ` +
  `of plain English starting with "Refused because". ` +
  `The reader is a regular person, not a planner. Name the actual problems ` +
  `(too close to a sewer, would overlook neighbours, no drainage details, out of character ` +
  `with the area…), never the policy or plan citations. ` +
  `If there are several reasons, mention the main ones. Keep it under 35 words. ` +
  NO_LEAK_RULE;

// Assistant-voice tells that mean the model refused or asked for more rather
// than summarising. Any of these means "no usable summary" → return null.
const LEAK_RE =
  /\b(?:I (?:don'?t|do not|cannot|can'?t|couldn'?t|am unable|'?m unable|'?m sorry)|as an AI|could you (?:provide|clarify|share)|please provide|not enough (?:info|information|detail)|appears? (?:incomplete|to be incomplete)|the (?:description|text) (?:appears|seems|is) |would you like|unable to (?:summari|determine|tell))/i;

/** Gate a model reply: null unless it is a real summary (not the INSUFFICIENT
 *  sentinel and not a conversational refusal/prompt leak). */
export function isUsableSummary(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t || /^insufficient[.!]?$/i.test(t) || LEAK_RE.test(t)) return null;
  return t;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

async function callClaude(
  system: string,
  content: string | ContentBlock[],
  maxTokens = 120,
  timeoutMs = TIMEOUT_MS
): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((b) => b.type === "text")?.text?.trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const callHaiku = (system: string, userMsg: string) => callClaude(system, userMsg);

export async function summariseDescription(
  description: string,
  applicationType?: string | null
): Promise<string | null> {
  if (!description) return null;
  const userMsg = applicationType
    ? `Application type: ${applicationType}\nDescription: ${description}`
    : description;
  return isUsableSummary(await callHaiku(DESCRIPTION_PROMPT, userMsg));
}

export async function summariseRefusal(
  reasons: Array<{ title: string; text: string }>
): Promise<string | null> {
  if (!reasons.length) return null;
  const userMsg = reasons
    .map((r, i) => `Reason ${i + 1}: ${r.title}\n${r.text}`)
    .join("\n\n");
  return isUsableSummary(await callHaiku(REFUSAL_PROMPT, userMsg));
}

const APPEAL_PROMPT =
  `You explain the outcome of an Irish planning appeal to a regular person in plain English. ` +
  `Appeals are decided nationally by An Coimisiún Pleanála (formerly An Bord Pleanála), and the ` +
  `Commission's decision replaces the council's. Write a short, flowing summary of a few sentences: ` +
  `who appealed and what was at stake, then — if the appeal has been decided — what the Commission ` +
  `decided and the main practical reasons. If it is not yet decided, say it is still under ` +
  `consideration and what is being contested. Name real issues (overlooking neighbours, traffic, ` +
  `height and scale, drainage…), never policy or plan citations. ` +
  `FORMAT: plain prose only — no Markdown, asterisks, bold, headings, bullet points, section labels ` +
  `or a title. Do not restate the address as a heading; begin directly with the summary. ` +
  `Use only what the material states — never invent details. ` +
  NO_LEAK_RULE;

/** Belt-and-braces cleanup for the odd time the model still emits Markdown. */
function sanitiseSummary(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Plain-English summary of an appeal and (where decided) the Commission's
 * decision. When a case document (board order / inspector's report) is
 * supplied it is attached for the model to read directly; otherwise the
 * summary is drawn from the structured context alone.
 */
export async function summariseAppeal(
  context: string,
  pdfBase64?: string | null
): Promise<string | null> {
  if (!context.trim() && !pdfBase64) return null;
  let text: string | null;
  if (pdfBase64) {
    const content: ContentBlock[] = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: `${context}\n\nSummarise this appeal and its decision for a general reader.` },
    ];
    // PDFs take longer to process, so allow a wider window and more tokens.
    text = await callClaude(APPEAL_PROMPT, content, 320, 25_000);
  } else {
    text = await callClaude(APPEAL_PROMPT, context, 320);
  }
  const usable = isUsableSummary(text);
  return usable ? sanitiseSummary(usable) : null;
}

const DECISION_DOC_PROMPT =
  `You read an Irish council's planning decision order and explain it to a regular person in plain ` +
  `English. If permission was REFUSED, begin "Refused because" and give the main real reasons ` +
  `(too close to a sewer, would overlook neighbours, traffic, out of character with the area, no ` +
  `drainage details…), never the policy or plan citations. If GRANTED, say it was granted and note ` +
  `any significant conditions (financial contributions, construction hours, design or material ` +
  `changes, landscaping). Two or three short sentences. ` +
  `FORMAT: plain prose only — no Markdown, asterisks, headings, bullet points or a title. ` +
  `Use only what the order states — never invent details. ` +
  NO_LEAK_RULE;

/**
 * Summarise a council's scanned decision order (the "Notification of Decision"
 * PDF) — the only place eplanning/iDocs councils like Kildare record their
 * reasons. The PDF is read directly by the model (works on scanned images too).
 */
export async function summariseDecisionDocument(
  pdfBase64: string,
  decision: string | null
): Promise<string | null> {
  if (!pdfBase64) return null;
  const context = decision ? `The recorded decision is: ${decision}.` : "";
  const content: ContentBlock[] = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `${context}\nSummarise what the council decided and why, for a general reader.` },
  ];
  const text = await callClaude(DECISION_DOC_PROMPT, content, 320, 25_000);
  const usable = isUsableSummary(text);
  return usable ? sanitiseSummary(usable) : null;
}
