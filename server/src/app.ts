import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { registerRoutes } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  /** Serve the built SPA from web/dist (long-running server mode). */
  serveStatic?: boolean;
  /** Open the database read-only (serverless mode with a bundled DB). */
  readonlyDb?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const db = openDb(undefined, { readonly: opts.readonlyDb });
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });
  await app.register(cors, { origin: true });
  registerRoutes(app, db);

  if (opts.serveStatic) {
    const webDist = path.resolve(__dirname, "../../web/dist");
    if (fs.existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
        return reply.sendFile("index.html");
      });
    }
  }
  return app;
}
