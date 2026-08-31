import { createHash } from "node:crypto";
import type { TestStatus } from "@qualityguard/core";
import { redactText } from "@qualityguard/core";
import type { ParsedReport, ParsedSuite, ParsedTestResult, ParseOptions } from "./report.js";
import { TestReportError } from "./report.js";

/**
 * Defensive parser for the Jest-compatible JSON emitted by `vitest --reporter=json`
 * (also produced by Jest itself). Like the Playwright parser, every field of the
 * external report is treated as untrusted and optional.
 */

const MAXIMUM_ERROR_LENGTH = 2000;
const DEFAULT_CRITICAL_TAG = "@critical";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const cleanMessage = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const truncated =
    trimmed.length > MAXIMUM_ERROR_LENGTH ? `${trimmed.slice(0, MAXIMUM_ERROR_LENGTH)}…` : trimmed;
  return redactText(truncated);
};

const resolveStatus = (status: string | null): TestStatus => {
  switch (status) {
    case "passed":
      return "PASSED";
    case "failed":
      return "FAILED";
    case "pending":
    case "skipped":
    case "todo":
    case "disabled":
      return "SKIPPED";
    default:
      return "FAILED";
  }
};

const buildIdentity = (file: string, fullName: string): string =>
  createHash("sha256").update(`${file}::${fullName}`, "utf8").digest("hex").slice(0, 32);

/** Normalises an absolute test path to a repository-relative, forward-slash path. */
const toRelativeFile = (file: string, workingDirectory: string | undefined): string => {
  const normalised = file.replaceAll("\\", "/");
  if (!workingDirectory) return normalised;
  const root = workingDirectory.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalised.startsWith(`${root}/`) ? normalised.slice(root.length + 1) : normalised;
};

export interface VitestParseOptions extends ParseOptions {
  /** Used to turn absolute file paths in the report into relative ones. */
  workingDirectory?: string;
}

export const parseVitestJsonReport = (
  raw: unknown,
  options: VitestParseOptions
): ParsedReport => {
  if (!isRecord(raw)) {
    throw new TestReportError("The vitest report is not a JSON object.");
  }
  if (!Array.isArray(raw.testResults)) {
    throw new TestReportError("The vitest report does not contain a testResults array.");
  }

  const criticalTag = (options.criticalTag ?? DEFAULT_CRITICAL_TAG).toLowerCase();
  const suites: ParsedSuite[] = [];
  const reportErrors: string[] = [];

  for (const fileResult of raw.testResults) {
    if (!isRecord(fileResult)) continue;
    const file = toRelativeFile(
      asString(fileResult.name) ?? "unknown file",
      options.workingDirectory
    );
    const results: ParsedTestResult[] = [];

    for (const assertion of asArray(fileResult.assertionResults)) {
      if (!isRecord(assertion)) continue;

      const title = asString(assertion.title) ?? "unnamed test";
      const ancestors = asArray(assertion.ancestorTitles)
        .map(asString)
        .filter((value): value is string => value !== null);
      const fullName = asString(assertion.fullName) ?? [...ancestors, title].join(" > ");
      const failures = asArray(assertion.failureMessages)
        .map(asString)
        .filter((value): value is string => value !== null);
      const status = resolveStatus(asString(assertion.status));
      const searchable = `${fullName} ${ancestors.join(" ")}`.toLowerCase();

      results.push({
        identity: buildIdentity(file, fullName),
        title: fullName,
        status,
        durationMs: Math.round(asNumber(assertion.duration)),
        // The vitest JSON report does not expose per-test retries, so flakiness is
        // not inferred here rather than guessed.
        retries: 0,
        critical: options.criticalByDefault || searchable.includes(criticalTag),
        errorType: status === "FAILED" ? "ERROR" : null,
        errorMessage: status === "FAILED" ? cleanMessage(failures.join("\n")) : null,
        attachments: []
      });
    }

    if (results.length > 0) {
      suites.push({
        title: file,
        file,
        durationMs: results.reduce((total, result) => total + result.durationMs, 0),
        results
      });
      continue;
    }

    // A file that produced no assertions but reported a message failed to load.
    const message = cleanMessage(asString(fileResult.message));
    if (message) reportErrors.push(`${file}: ${message}`);
  }

  return { suites, reportErrors };
};
