/**
 * Vercel serverless entry: wraps the compiled Fastify app and serves every
 * /api/* route from one function. The SQLite database is built during
 * `vercel build` (seed or live ingest), converted out of WAL mode, and
 * bundled read-only alongside the function.
 */
import path from "node:path";

process.env.PLANVIEW_DB ??= path.join(process.cwd(), "server/data/planview.db");

let appPromise;

export default async function handler(req, res) {
  appPromise ??= (async () => {
    const { buildApp } = await import("../server/dist/app.js");
    const app = await buildApp({ serveStatic: false, readonlyDb: true, logger: false });
    await app.ready();
    return app;
  })();
  const app = await appPromise;
  app.server.emit("request", req, res);
}
