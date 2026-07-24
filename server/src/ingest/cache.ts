/**
 * Tiny on-disk cache for build-time ingest of *immutable* data.
 *
 * Vercel preserves `.vercel/cache` between builds, so anything that can never
 * change once published — a closed year of the Property Price Register, say —
 * only has to be downloaded on the first build that needs it. Everything
 * volatile (this year's sales, planning applications) is always fetched fresh.
 *
 * Best-effort by design: a cache miss, an unreadable entry or a read-only disk
 * just means we fetch, so a build is never blocked by the cache.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this module, not the cwd, so it lands in the same place whether
// run from the server workspace, the repo root or a test runner: this file sits
// at server/{src,dist}/ingest/, three levels below the repo root.
const CACHE_DIR =
  process.env.PLANVIEW_CACHE_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.vercel/cache/planview");

const entryPath = (key: string): string =>
  path.join(CACHE_DIR, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);

export function cacheRead<T>(key: string): T | null {
  try {
    const raw = fs.readFileSync(entryPath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function cacheWrite(key: string, value: unknown): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(entryPath(key), JSON.stringify(value));
  } catch {
    // A read-only or full disk must not fail the build.
  }
}
