import type { HistoryCommit } from "@evidence-gate/git-history";
import { summariseByPath } from "@evidence-gate/git-history";

/**
 * Builds a first configuration by looking at the project instead of asking the person
 * to write one. Everything it proposes is derived from something observable — the
 * package manifest, the files on disk, the commit history — and the notes say where
 * each proposal came from, so it can be reviewed rather than trusted blindly.
 */

export interface DetectedSuite {
  key: string;
  kind: "SMOKE" | "REGRESSION" | "API";
  command: string;
  args: string[];
  reportFormat: "playwright-json" | "vitest-json";
  critical: boolean;
}

export interface InitResult {
  config: Record<string, unknown>;
  notes: string[];
  warnings: string[];
}

export interface PackageManifest {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

export interface BuildInitOptions {
  /** Parsed package.json, or null when the project has none. */
  manifest: PackageManifest | null;
  /** Commits from the window; empty when there is no readable history. */
  commits: readonly HistoryCommit[];
  /** Repository-relative test file paths found on disk. */
  testFiles: readonly string[];
  /** Fallback project name when the manifest has none. */
  directoryName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dependencyNames = (manifest: PackageManifest | null): Set<string> => {
  const names = new Set<string>();
  for (const field of [manifest?.dependencies, manifest?.devDependencies]) {
    if (isRecord(field)) for (const name of Object.keys(field)) names.add(name);
  }
  return names;
};

const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "project" : slug;
};

const REPORT_ARGUMENT = "--outputFile={{reportPath}}";

const detectSuites = (manifest: PackageManifest | null): DetectedSuite[] => {
  const dependencies = dependencyNames(manifest);
  const suites: DetectedSuite[] = [];

  if (dependencies.has("vitest")) {
    suites.push({
      key: "unit",
      kind: "REGRESSION",
      command: "node",
      args: ["./node_modules/vitest/vitest.mjs", "run", "--reporter=json", REPORT_ARGUMENT],
      reportFormat: "vitest-json",
      critical: false
    });
  } else if (dependencies.has("jest")) {
    suites.push({
      key: "unit",
      kind: "REGRESSION",
      command: "node",
      args: ["./node_modules/jest/bin/jest.js", "--json", REPORT_ARGUMENT],
      reportFormat: "vitest-json",
      critical: false
    });
  }

  if (dependencies.has("@playwright/test")) {
    suites.push({
      key: "e2e",
      kind: "SMOKE",
      command: "node",
      args: ["./node_modules/@playwright/test/cli.js", "test", "--reporter=json"],
      reportFormat: "playwright-json",
      critical: false
    });
  }

  return suites;
};

/** Groups a path into the area it belongs to: two segments deep, or one when shallow. */
export const areaOf = (path: string): string | null => {
  const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment !== "");
  if (segments.length <= 1) return null;
  return segments.slice(0, Math.min(2, segments.length - 1)).join("/");
};

const titleCase = (area: string): string =>
  area
    .split("/")
    .at(-1)!
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const MINIMUM_CRITICALITY = 40;
const CRITICALITY_RANGE = 50;
const MAXIMUM_RULES = 12;

/**
 * Proposes criticality from where fixes land. The area with the most fixes gets the
 * top of the band; the rest scale against it. It is a starting point drawn from the
 * repository's own history, not a judgement about the business.
 */
export const proposeCriticalityRules = (
  commits: readonly HistoryCommit[]
): { pathPrefix: string; area: string; businessCriticality: number }[] => {
  const byPath = summariseByPath(commits);
  const fixesByArea = new Map<string, number>();

  for (const [path, history] of byPath) {
    const area = areaOf(path);
    if (area === null) continue;
    fixesByArea.set(area, (fixesByArea.get(area) ?? 0) + history.fixes);
  }

  const ranked = [...fixesByArea.entries()]
    .filter(([, fixes]) => fixes > 0)
    .sort(([leftArea, leftFixes], [rightArea, rightFixes]) =>
      rightFixes === leftFixes ? leftArea.localeCompare(rightArea) : rightFixes - leftFixes
    )
    .slice(0, MAXIMUM_RULES);

  const mostFixes = ranked[0]?.[1] ?? 0;
  if (mostFixes === 0) return [];

  return ranked.map(([area, fixes]) => ({
    pathPrefix: `${area}/`,
    area: titleCase(area),
    businessCriticality: MINIMUM_CRITICALITY + Math.round((CRITICALITY_RANGE * fixes) / mostFixes)
  }));
};

export const buildInitialConfig = (options: BuildInitOptions): InitResult => {
  const notes: string[] = [];
  const warnings: string[] = [];

  const manifestName = typeof options.manifest?.name === "string" ? options.manifest.name : null;
  const project = slugify(manifestName ?? options.directoryName);
  notes.push(
    manifestName === null
      ? `Project name taken from the directory: ${project}`
      : `Project name taken from package.json: ${project}`
  );

  const suites = detectSuites(options.manifest);
  if (suites.length === 0) {
    warnings.push(
      "No test runner was detected. Add a suite to execution.suites — without one there is no test evidence to judge."
    );
  } else {
    notes.push(
      `Test runner detected: ${suites.map((suite) => `${suite.key} (${suite.reportFormat})`).join(", ")}`
    );
  }

  if (options.testFiles.length === 0) {
    warnings.push("No test file was found on disk; related-test counting will report zero.");
  } else {
    notes.push(`${String(options.testFiles.length)} test file(s) found.`);
  }

  const criticalityRules = proposeCriticalityRules(options.commits);
  if (options.commits.length === 0) {
    warnings.push(
      "No commit history was readable, so no criticality rule could be proposed. Add rules for the areas that matter."
    );
  } else if (criticalityRules.length === 0) {
    warnings.push(
      "The history has no commit declaring a fix, so criticality could not be inferred. Add rules for the areas that matter."
    );
  } else {
    notes.push(
      `Criticality proposed from ${String(options.commits.length)} commits, ranked by where fixes land. Review these numbers: they describe history, not business value.`
    );
  }

  const config: Record<string, unknown> = {
    project,
    baseRef: "origin/main",
    criticalityRules,
    execution: {
      workingDirectory: ".",
      artifactsRoot: ".evidence-gate/artifacts",
      suites
    }
  };

  notes.push(
    "Risk metrics are not written to the file: change frequency, bug history and related tests are counted from the git history on every run."
  );

  return { config, notes, warnings };
};
