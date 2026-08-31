import { spawnSync } from "node:child_process";
import type { PathHistory } from "./parse.js";
import { COMMIT_MARKER, parseGitLog, summariseByPath } from "./parse.js";
import { readdirSync } from "node:fs";
import { countRelatedTests, findTestFiles, isTestFile } from "./related-tests.js";

export * from "./parse.js";
export * from "./related-tests.js";

/**
 * Derives risk metrics from the repository's own history, so nobody has to type how
 * many bugs an area had. Every number here is counted, not estimated; what cannot be
 * counted is left absent, and the risk engine treats absence as absence.
 */

export interface DerivedRiskMetrics {
  changesLast90Days?: number;
  bugCount?: number;
  relatedTests?: number;
}

export interface DerivedMetricsResult {
  metrics: DerivedRiskMetrics;
  /** Why a metric is missing, so the report can say so instead of staying silent. */
  unavailable: string[];
  windowDays: number;
  commitsAnalysed: number;
}

export interface DeriveOptions {
  cwd: string;
  /** Repository-relative paths touched by the change under analysis. */
  changedPaths: readonly string[];
  /** Test files to consider when counting related tests. */
  testFiles?: readonly string[];
  windowDays?: number;
  /** Injected in tests; defaults to running git. */
  readLog?: (cwd: string, windowDays: number) => string | null;
}

const DEFAULT_WINDOW_DAYS = 90;
const MAXIMUM_BUFFER = 64 * 1024 * 1024;

const runGitLog = (cwd: string, windowDays: number): string | null => {
  const result = spawnSync(
    "git",
    [
      "log",
      `--since=${String(windowDays)}.days.ago`,
      "--no-merges",
      "--name-only",
      `--pretty=format:${COMMIT_MARKER}%H%x09%s`
    ],
    { cwd, shell: false, windowsHide: true, encoding: "utf8", maxBuffer: MAXIMUM_BUFFER }
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout;
};

const normalise = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

/** Source files only: a change to a test or a document carries no test gap of its own. */
const sourcePathsOf = (paths: readonly string[]): string[] =>
  paths.map(normalise).filter((path) => !isTestFile(path) && /\.[cm]?[jt]sx?$/i.test(path));

/**
 * The hottest file drives the risk of the whole change: a change touching one
 * frequently-broken file plus twenty stable ones is as risky as that one file.
 */
const maxOf = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : Math.max(...values);

/** The least covered file drives the test gap, for the same reason. */
const minOf = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : Math.min(...values);

/** Discovers the project's test files from disk. */
export const discoverTestFiles = (root: string): string[] =>
  findTestFiles(root, {
    readdir: (path) => readdirSync(path, { withFileTypes: true })
  });

export const deriveRiskMetrics = (options: DeriveOptions): DerivedMetricsResult => {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const unavailable: string[] = [];
  const changedPaths = options.changedPaths.map(normalise);

  const readLog = options.readLog ?? runGitLog;
  const output = readLog(options.cwd, windowDays);

  if (output === null) {
    return {
      metrics: {},
      unavailable: [
        "changesLast90Days: the git history could not be read",
        "bugCount: the git history could not be read",
        "relatedTests: not attempted without a history"
      ],
      windowDays,
      commitsAnalysed: 0
    };
  }

  const commits = parseGitLog(output);
  const byPath: Map<string, PathHistory> = summariseByPath(commits);

  const histories = changedPaths.map((path) => byPath.get(path) ?? { changes: 0, fixes: 0 });
  const metrics: DerivedRiskMetrics = {};

  const changes = maxOf(histories.map((history) => history.changes));
  if (changes === undefined) {
    unavailable.push("changesLast90Days: the change touches no file");
  } else {
    metrics.changesLast90Days = changes;
  }

  const fixes = maxOf(histories.map((history) => history.fixes));
  if (fixes === undefined) {
    unavailable.push("bugCount: the change touches no file");
  } else {
    metrics.bugCount = fixes;
  }

  const sourcePaths = sourcePathsOf(changedPaths);
  if (options.testFiles === undefined) {
    unavailable.push("relatedTests: no test files were listed");
  } else if (sourcePaths.length === 0) {
    unavailable.push("relatedTests: the change touches no source file");
  } else {
    const counts = sourcePaths.map((path) =>
      countRelatedTests(path, { testFiles: options.testFiles ?? [] })
    );
    const related = minOf(counts);
    if (related !== undefined) metrics.relatedTests = related;
  }

  return { metrics, unavailable, windowDays, commitsAnalysed: commits.length };
};
