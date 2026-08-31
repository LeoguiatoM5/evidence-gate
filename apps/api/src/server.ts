import "dotenv/config";
import { buildApp } from "./app.js";

const app = buildApp();
const port = Number.parseInt(process.env.PORT ?? "3333", 10);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
