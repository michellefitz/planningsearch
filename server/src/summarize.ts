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

async function callHaiku(system: string, userMsg: string): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
        max_tokens: 120,
        system,
        messages: [{ role: "user", content: userMsg }],
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
