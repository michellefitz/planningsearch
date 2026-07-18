import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  const app = await buildApp({ serveStatic: true });
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
