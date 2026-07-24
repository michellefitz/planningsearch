export async function sql(query, params = []) {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL not set");
  const host = new URL(cs).hostname;
  const res = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": cs,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) throw new Error(`neon: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.rows ?? [];
}
