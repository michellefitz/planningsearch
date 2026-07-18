/**
 * Document access helpers (PRD §7.3) — the deep-link tier plus on-demand
 * file-list fetching where a council's URL scheme makes it derivable.
 *
 * Kildare (eplanning.ie): the application id in
 *   https://www.eplanning.ie/KildareCC/AppFileRefDetails/{id}/0
 * is the same id used by the council's iDocs scanned-file listing:
 *   https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id={id}
 *
 * Fetching happens only on user request (no caching, no bulk mirroring) —
 * anything heavier is Phase 0/2 territory per the PRD.
 */

export function deriveScannedFilesUrl(
  authorityId: string,
  sourceUrl: string | null | undefined
): string | null {
  if (!sourceUrl) return null;
  if (authorityId === "kildare") {
    const m = sourceUrl.match(/AppFileRefDetails\/(\d+)/i);
    if (m) {
      return `https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=${m[1]}`;
    }
  }
  return null;
}

export interface ScannedFile {
  title: string;
  url: string;
}

/**
 * Tolerant parser for a council file-listing HTML page: collects anchors that
 * look like document links and resolves them against the page URL. Built
 * defensively (the markup is not under our control) — an empty result means
 * "fall back to the deep link", never a hard failure.
 */
export function parseFileListHtml(html: string, baseUrl: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const docHref = /\.(pdf|tiff?|jpe?g|png|doc|docx)([?#]|$)|getfile|getdocument|viewdocument|download|openfile|docid=|fileid=/i;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) continue;
    if (!docHref.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const title =
      m[2]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim() || decodeURIComponent(abs.split("/").pop() ?? "Document");
    files.push({ title, url: abs });
  }
  return files;
}

const FETCH_TIMEOUT_MS = 12_000;

/** Live-fetch and parse a file listing; returns null when unreachable/unparsable. */
export async function fetchScannedFileList(listUrl: string): Promise<ScannedFile[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(listUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "PlanView/0.1 (planning register viewer; respectful on-demand fetch)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const files = parseFileListHtml(html, listUrl);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
