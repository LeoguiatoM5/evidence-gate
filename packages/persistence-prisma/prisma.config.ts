import "dotenv/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = resolve(packageRoot, "../../data/qualityguard.db").replaceAll("\\", "/");

export default defineConfig({
  schema: resolve(packageRoot, "prisma/schema.prisma"),
  migrations: {
    path: resolve(packageRoot, "prisma/migrations")
  },
  datasource: {
    url: process.env.DATABASE_URL ?? `file:${defaultDatabasePath}`
  }
});
