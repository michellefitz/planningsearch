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
  `of plain English starting with "Refused because". The reader is a regular person, not a planner. ` +
  `For refusals on planning merits, name the actual problems (too close to a sewer, would overlook ` +
  `neighbours, no drainage details, out of character with the area…) rather than the policy or plan ` +
  `citation numbers. For procedural or statutory refusals — e.g. an extension of duration refused ` +
  `because works had not commenced or the legal basis was removed, or an application refused as ` +
  `invalid or out of time — explain that reason plainly in everyday terms (say why permission or the ` +
  `extension could no longer be granted). Always produce a sentence when a reason is given. ` +
  `If there are several reasons, mention the main ones. Keep it under 40 words. ` +
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

export async function callClaude(
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

const DOC_READ_PROMPT =
  `You read a document from an Irish planning application file (inspector's report, decision order, ` +
  `planner's report, submission…) and answer a question about it for a planning research assistant. ` +
  `Be concrete and specific: report what the document actually says — recommendations, conditions, ` +
  `reasons, figures, dates, who said what — in plain English a regular person follows. ` +
  `FORMAT: plain prose only — no Markdown, headings or bullet points. ` +
  `If the document does not answer the question, say so briefly and state what it does contain. ` +
  `Use only what the document states — never invent details.`;

/**
 * Agent tool backend: attach a fetched PDF and answer a question about it
 * (or summarise it when no question is given). Unlike the summary prompts,
 * "the document doesn't say" is a legitimate answer here — the agent relays
 * it — so there is no INSUFFICIENT sentinel.
 */
export async function readDocumentWithClaude(
  pdfBase64: string,
  context: string,
  question?: string | null
): Promise<string | null> {
  const ask = question?.trim() || "Summarise this document's key points for a general reader.";
  const content: ContentBlock[] = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `${context}\n\n${ask}` },
  ];
  const text = await callClaude(DOC_READ_PROMPT, content, 700, 45_000);
  return text ? sanitiseSummary(text) : null;
}

export interface DecisionExtract {
  /** One or two plain-English sentences on the outcome. */
  summary: string | null;
  /** Conditions of grant — the limitations attached to a permission. */
  conditions: Array<{ number: number | null; title: string; text: string }>;
  /** Reasons for refusal. */
  reasons: Array<{ number: number | null; text: string }>;
}

const DECISION_EXTRACT_PROMPT =
  `You read an Irish council planning decision order and extract it as JSON for a public planning ` +
  `viewer. Return ONLY a JSON object — no prose, no Markdown fences — with exactly this shape:\n` +
  `{"summary": string, "conditions": [{"number": number|null, "title": string, "text": string}], ` +
  `"reasons": [{"number": number|null, "text": string}]}\n` +
  `- summary: one or two plain-English sentences a regular person understands. If REFUSED, begin ` +
  `"Refused because" and give the real problems (overlooking, traffic, drainage, out of character…), ` +
  `not policy citations. If GRANTED, say so and flag whether the conditions are routine or onerous.\n` +
  `- conditions: every CONDITION OF GRANT. number = its number; title = a short (max 8 words) ` +
  `plain-English label of what it controls (e.g. "Construction hours", "Development contribution", ` +
  `"Materials and finishes", "Landscaping"); text = the condition wording, lightly trimmed.\n` +
  `- reasons: every REASON FOR REFUSAL (number + wording).\n` +
  `If granted, reasons is []. If refused, conditions is []. Use only what the order states — never ` +
  `invent items.`;

export function parseJsonLoose(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const clip = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);
const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Extract a council's scanned decision order (the "Notification of Decision"
 * PDF) into a structured decision — the summary, the conditions of grant, and
 * any reasons for refusal. This is the only place eplanning/iDocs councils like
 * Kildare record their conditions. The PDF is read directly by the model (it
 * OCRs scanned images too). Returns null if nothing usable comes back.
 */
export async function extractDecisionDocument(
  pdfBase64: string,
  decision: string | null
): Promise<DecisionExtract | null> {
  if (!pdfBase64) return null;
  const content: ContentBlock[] = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `Recorded decision: ${decision ?? "unknown"}. Extract the decision order as JSON.` },
  ];
  const raw = await callClaude(DECISION_EXTRACT_PROMPT, content, 2000, 30_000);
  const parsed = raw ? (parseJsonLoose(raw) as Record<string, unknown> | null) : null;
  if (!parsed || typeof parsed !== "object") return null;
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary : null;
  const summary = summaryRaw ? isUsableSummary(sanitiseSummary(summaryRaw)) : null;
  const conditions = Array.isArray(parsed.conditions)
    ? parsed.conditions
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          return { number: numOrNull(o.number), title: clip(o.title, 80), text: clip(o.text, 1200) };
        })
        .filter((c) => c.title || c.text)
        .slice(0, 40)
    : [];
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          return { number: numOrNull(o.number), text: clip(o.text, 1200) };
        })
        .filter((r) => r.text)
        .slice(0, 40)
    : [];
  if (!summary && conditions.length === 0 && reasons.length === 0) return null;
  return { summary, conditions, reasons };
}
