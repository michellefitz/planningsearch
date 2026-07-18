const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT =
  `You summarise Irish planning applications in one short sentence of plain English. ` +
  `The reader is a regular person, not a planner or architect. ` +
  `Say what the project actually is: an extension, a new house, a commercial unit, solar panels, etc. ` +
  `Include key details like number of bedrooms or storeys only when stated. ` +
  `Never start with "This application is for". Just state what it is. ` +
  `Keep it under 30 words.`;

export async function summariseDescription(
  description: string,
  applicationType?: string | null
): Promise<string | null> {
  if (!ANTHROPIC_API_KEY || !description) return null;

  const userMsg = applicationType
    ? `Application type: ${applicationType}\nDescription: ${description}`
    : description;

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
        max_tokens: 100,
        system: SYSTEM_PROMPT,
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
