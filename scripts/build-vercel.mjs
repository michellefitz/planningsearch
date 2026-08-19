/**
 * Vercel build using the Build Output API (.vercel/output), which bypasses
 * all framework auto-detection — Vercel serves exactly what we assemble here.
 *
 * Produces:
 *   .vercel/output/static/            → the built SPA (web/dist)
 *   .vercel/output/functions/api.func → the dependency-free API function
 *   .vercel/output/config.json        → routes (/api/* → function, SPA fallback)
 *
 * The API function has zero npm dependencies (Node builtins + a bundled JSON
 * file), so the .func is just the handler plus its data.
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
for (const dir of ["_accounts", "_preplan", "_conditions", "_ai", "_search"]) {
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
