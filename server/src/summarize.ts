const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 10_000;

const DESCRIPTION_PROMPT =
  `You summarise Irish planning applications in one short sentence of plain English. ` +
  `The reader is a regular person, not a planner or architect. ` +
  `Say what the project actually is: an extension, a new house, a commercial unit, solar panels, etc. ` +
  `Include key details like number of bedrooms or storeys only when stated. ` +
  `Never start with "This application is for". Just state what it is. ` +
  `Keep it under 30 words.`;

const REFUSAL_PROMPT =
  `You explain why an Irish council refused a planning application, in one short sentence ` +
  `of plain English starting with "Refused because". ` +
  `The reader is a regular person, not a planner. Name the actual problems ` +
  `(too close to a sewer, would overlook neighbours, no drainage details, out of character ` +
  `with the area…), never the policy or plan citations. ` +
  `If there are several reasons, mention the main ones. Keep it under 35 words.`;

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
  return callHaiku(DESCRIPTION_PROMPT, userMsg);
}

export async function summariseRefusal(
  reasons: Array<{ title: string; text: string }>
): Promise<string | null> {
  if (!reasons.length) return null;
  const userMsg = reasons
    .map((r, i) => `Reason ${i + 1}: ${r.title}\n${r.text}`)
    .join("\n\n");
  return callHaiku(REFUSAL_PROMPT, userMsg);
}

const APPEAL_PROMPT =
  `You explain the outcome of an Irish planning appeal to a regular person in plain English. ` +
  `Appeals are decided nationally by An Coimisiún Pleanála (formerly An Bord Pleanála), and the ` +
  `Commission's decision replaces the council's. In 2-3 short sentences: say who appealed and ` +
  `what was at stake, then — if the appeal has been decided — what the Commission decided and the ` +
  `main practical reasons. If it is not yet decided, say it is still under consideration and what ` +
  `is being contested. Name real issues (overlooking neighbours, traffic, height and scale, ` +
  `drainage…), never policy or plan citations. Use only what the material states — never invent details.`;

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
  if (pdfBase64) {
    const content: ContentBlock[] = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: `${context}\n\nSummarise this appeal and its decision for a general reader.` },
    ];
    // PDFs take longer to process, so allow a wider window and more tokens.
    return callClaude(APPEAL_PROMPT, content, 320, 25_000);
  }
  return callClaude(APPEAL_PROMPT, context, 320);
}
