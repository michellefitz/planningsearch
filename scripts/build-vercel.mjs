/**
 * Vercel build using the Build Output API (.vercel/output), which bypasses
 * all framework auto-detection — Vercel serves exactly what we assemble here.
 *
 * Produces:
 *   .vercel/output/static/            → the built SPA (web/dist)
 *   .vercel/output/functions/api.func → the dependency-free API function
 *   .vercel/output/config.json        → routes (/api/* → function, SPA fallback)
 *
 * The API function has zero npm dependencies — Node builtins, a bundled JSON
 * file, and one vendored .wasm (the DjVu decoder the older council scans need;
 * see api/_documents/djvu.mjs). So the .func is just the handler plus its data.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

// 1. Build the SPA and generate the data bundle.
run("npm run build --workspace web");
run("npm run export:json --workspace server");

const out = path.join(root, ".vercel", "output");
fs.rmSync(out, { recursive: true, force: true });

// 2. Static assets.
const staticDir = path.join(out, "static");
fs.mkdirSync(staticDir, { recursive: true });
fs.cpSync(path.join(root, "web", "dist"), staticDir, { recursive: true });

// 3. Serverless function.
const funcDir = path.join(out, "functions", "api.func");
fs.mkdirSync(funcDir, { recursive: true });
// Everything under api/ is underscore-prefixed so Vercel's zero-config api
// builder ignores it — otherwise each helper .mjs deploys as its own
// serverless function (Hobby caps a deployment at 12; we hit 13).
fs.copyFileSync(path.join(root, "api", "_index.mjs"), path.join(funcDir, "index.mjs"));
// summaries.jsonl is the backfill's append-only working file; only the
// summaries.json the export derives from it belongs in the function.
fs.cpSync(path.join(root, "api", "_data"), path.join(funcDir, "_data"), {
  recursive: true,
  filter: (src) => !src.endsWith(".jsonl"),
});
// Every directory _index.mjs imports from. Missing one is not a build error —
// it is a runtime crash on the first request that touches it.
for (const dir of ["_accounts", "_preplan", "_conditions", "_ai", "_search", "_documents", "_related"]) {
  fs.cpSync(path.join(root, "api", dir), path.join(funcDir, dir), { recursive: true });
}
fs.writeFileSync(
  path.join(funcDir, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      // The agent endpoint streams SSE and can run for several tool turns.
      supportsResponseStreaming: true,
      maxDuration: 300,
      // The full-depth (2012+) bundle needs ~900 MB resident after indexing.
      memory: 2048,
    },
    null,
    2
  )
);
// Mark the function as ESM so `export default` loads correctly.
fs.writeFileSync(path.join(funcDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));

// 4. Routing: API first, then static files, then SPA fallback to index.html.
fs.writeFileSync(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "/(.*)",
          headers: {
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Permissions-Policy": "geolocation=(self)",
          },
          continue: true,
        },
        { src: "/api/(.*)", dest: "/api" },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2
  )
);

console.log("Assembled .vercel/output (Build Output API).");

// 6. Report what the function actually weighs.
//
// Every data file inside the function scales with the register — the bundle,
// the boundaries, the extents, the summaries. So this one number decides when
// the next council can be loaded, and it was not printed anywhere: the
// individual files were logged during the export, the total never was. See
// issue #101.
//
// The uncompressed-function cap is 250 MB by default, but this project runs on
// Vercel large functions (Fluid + Active CPU), which lifts it to 5 GB. So the
// report warns as the large-function headroom shrinks and only hard-fails past
// 5 GB — the point where Vercel itself would reject the upload. It must not
// fail at 250 MB: the function already ships at ~400 MB and deploys fine.
const FUNCTION_LIMIT_MB = 5000;
const FUNCTION_WARN_MB = 4000;

const sizeOf = (p) => {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
};
const entries = fs
  .readdirSync(funcDir)
  .map((name) => ({ name, bytes: sizeOf(path.join(funcDir, name)) }))
  .sort((a, b) => b.bytes - a.bytes);
const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
const totalMb = totalBytes / 1024 / 1024;
const mb = (b) => (b / 1024 / 1024).toFixed(1).padStart(7);

console.log(
  `\nFunction size: ${totalMb.toFixed(1)} MB ` +
    `(large-function limit ${FUNCTION_LIMIT_MB} MB; default cap 250 MB is lifted by Fluid)`
);
for (const e of entries) {
  if (e.bytes >= 512 * 1024) console.log(`  ${mb(e.bytes)} MB  ${e.name}`);
}

if (totalMb > FUNCTION_LIMIT_MB) {
  // Fail here rather than letting Vercel reject the upload: the message there
  // does not say which files grew, and this one does.
  console.error(
    `\nERROR: ${totalMb.toFixed(1)} MB exceeds the ${FUNCTION_LIMIT_MB} MB large-function limit — ` +
      `this deploy would fail. The data files above scale with the register; see issue #101.`
  );
  process.exit(1);
}
if (totalMb > FUNCTION_WARN_MB) {
  console.warn(
    `\nWARNING: ${(FUNCTION_LIMIT_MB - totalMb).toFixed(1)} MB of large-function headroom left. ` +
      `Loading another council adds to every data file above; see issue #101.`
  );
}
