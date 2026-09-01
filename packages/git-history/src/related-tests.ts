import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

/**
 * Counts the test files that plausibly cover a source file. Two deterministic
 * signals, no heuristics beyond them:
 *
 * 1. the test file's name carries the source file's stem (`limit.ts` ->
 *    `limit.test.ts`, `limit.spec.ts`);
 * 2. the test file imports the source module by path.
 *
 * A file matched by either signal counts once.
 */

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export const isTestFile = (path: string): boolean => TEST_FILE_PATTERN.test(path);

/** `src/payment/limit.ts` -> `limit`; also strips a `.test`/`.spec` segment. */
export const stemOf = (path: string): string => {
  const name = basename(path, extname(path));
  return name.replace(/\.(test|spec)$/i, "");
};

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const importsSource = (testContents: string, sourcePath: string): boolean => {
  const stem = stemOf(sourcePath);
  if (stem === "") return false;
  // Matches ./limit.js, ../payment/limit.ts, @scope/pkg/limit — the module
  // specifier ends with the stem, with or without an extension.
  const pattern = new RegExp(
    String.raw`from\s+["'][^"']*[/"']` +
      escapeForRegExp(stem) +
      String.raw`(\.[cm]?[jt]sx?)?["']`
  );
  return pattern.test(testContents);
};

export interface RelatedTestOptions {
  /** Absolute or repository-relative paths of every test file to consider. */
  testFiles: readonly string[];
  /** Reads a test file; injected so the counting stays testable. */
  readFile?: (path: string) => string;
}

export const countRelatedTests = (
  sourcePath: string,
  options: RelatedTestOptions
): number => {
  if (isTestFile(sourcePath)) return 0;
  const stem = stemOf(sourcePath);
  if (stem === "") return 0;

  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let related = 0;

  for (const testFile of options.testFiles) {
    if (stemOf(testFile) === stem) {
      related += 1;
      continue;
    }
    let contents: string;
    try {
      contents = read(testFile);
    } catch {
      continue;
    }
    if (importsSource(contents, sourcePath)) related += 1;
  }

  return related;
};

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "reports",
  ".next",
  ".cache",
  ".tmp",
  ".evidence-gate"
]);

const MAXIMUM_DEPTH = 8;
const MAXIMUM_TEST_FILES = 5000;

/** Walks the project for test files, skipping directories that never hold source. */
export const findTestFiles = (
  root: string,
  reader: {
    readdir: (path: string) => { name: string; isDirectory: () => boolean }[];
  }
): string[] => {
  const found: string[] = [];

  const walk = (directory: string, depth: number): void => {
    if (depth > MAXIMUM_DEPTH || found.length >= MAXIMUM_TEST_FILES) return;
    let entries;
    try {
      entries = reader.readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAXIMUM_TEST_FILES) return;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(path, depth + 1);
        continue;
      }
      if (isTestFile(entry.name)) found.push(path);
    }
  };

  walk(root.replaceAll("\\", "/").replace(/\/$/, ""), 0);
  return found;
};
