import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

export interface TestDatabase {
  path: string;
  url: string;
  remove: () => void;
}

const migrationsRoot = (): string =>
  resolve(process.cwd(), "packages", "persistence-prisma", "prisma", "migrations");

/** Applies every migration in order so tests run against the real schema. */
export const createTestDatabase = (label: string): TestDatabase => {
  const temporaryRoot = resolve(process.cwd(), ".tmp", label);
  mkdirSync(temporaryRoot, { recursive: true });
  const path = resolve(temporaryRoot, `${randomUUID()}.db`);

  const root = migrationsRoot();
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) throw new Error("No database migration was found.");

  const database = new Database(path);
  try {
    for (const directory of directories) {
      database.exec(readFileSync(resolve(root, directory, "migration.sql"), "utf8"));
    }
  } finally {
    database.close();
  }

  return {
    path,
    url: `file:${path.replaceAll("\\", "/")}`,
    remove: () => {
      rmSync(path, { force: true });
    }
  };
};
