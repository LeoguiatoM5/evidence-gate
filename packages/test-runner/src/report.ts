import { createHash } from "node:crypto";
import type { TestStatus } from "@evidence-gate/core";
import { redactText } from "@evidence-gate/core";

/**
 * Defensive parser for the Playwright JSON reporter. The report is produced by an
 * external process, so every field is treated as untrusted and optional.
 */

export interface ParsedAttachment {
  name: string;
  contentType: string | null;
  sourcePath: string | null;
}

export interface ParsedTestResult {
  identity: string;
  title: string;
  status: TestStatus;
  durationMs: number;
  retries: number;
  critical: boolean;
  errorType: string | null;
  errorMessage: string | null;
  attachments: ParsedAttachment[];
}

export interface ParsedSuite {
  title: string;
  file: string;
  durationMs: number;
  results: ParsedTestResult[];
}

export interface ParsedReport {
  suites: ParsedSuite[];
  reportErrors: string[];
}

export interface ParseOptions {
  /** Suites declared critical by policy mark every test as critical. */
  criticalByDefault: boolean;
  criticalTag?: string;
}

const MAXIMUM_ERROR_LENGTH = 2000;
const DEFAULT_CRITICAL_TAG = "@critical";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const truncate = (value: string): string =>
  value.length > MAXIMUM_ERROR_LENGTH ? `${value.slice(0, MAXIMUM_ERROR_LENGTH)}…` : value;

const cleanMessage = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : truncate(redactText(trimmed));
};

const resolveResultStatus = (testStatus: string | null, lastResultStatus: string | null): TestStatus => {
  if (testStatus === "skipped" || lastResultStatus === "skipped") return "SKIPPED";
  if (testStatus === "flaky") return "FLAKY";
  if (testStatus === "expected") return "PASSED";
  if (lastResultStatus === "timedOut") return "TIMED_OUT";
  if (testStatus === "unexpected" || lastResultStatus === "failed") return "FAILED";
  if (lastResultStatus === "passed") return "PASSED";
  return "FAILED";
};

const buildIdentity = (specId: string | null, file: string, titlePath: string): string => {
  if (specId && specId.trim() !== "") return specId;
  return createHash("sha256").update(`${file}::${titlePath}`, "utf8").digest("hex").slice(0, 32);
};

const extractErrorMessage = (result: Record<string, unknown>): string | null => {
  const error = result.error;
  if (isRecord(error)) {
    const message = asString(error.message);
    if (message) return cleanMessage(message);
  }
  const errors = asArray(result.errors);
  for (const candidate of errors) {
    if (isRecord(candidate)) {
      const message = asString(candidate.message);
      if (message) return cleanMessage(message);
    }
  }
  return null;
};

const extractAttachments = (result: Record<string, unknown>): ParsedAttachment[] => {
  const attachments: ParsedAttachment[] = [];
  for (const candidate of asArray(result.attachments)) {
    if (!isRecord(candidate)) continue;
    attachments.push({
      name: asString(candidate.name) ?? "attachment",
      contentType: asString(candidate.contentType),
      sourcePath: asString(candidate.path)
    });
  }
  return attachments;
};

const collectTags = (spec: Record<string, unknown>): string[] => {
  const tags: string[] = [];
  for (const tag of asArray(spec.tags)) {
    const value = asString(tag);
    if (value) tags.push(value.toLowerCase());
  }
  return tags;
};

const parseSpec = (
  spec: Record<string, unknown>,
  file: string,
  suiteTitlePath: string,
  options: ParseOptions
): ParsedTestResult[] => {
  const criticalTag = (options.criticalTag ?? DEFAULT_CRITICAL_TAG).toLowerCase();
  const specTitle = asString(spec.title) ?? "unnamed test";
  const tags = collectTags(spec);
  const titleCarriesTag = specTitle.toLowerCase().includes(criticalTag);
  const critical = options.criticalByDefault || tags.includes(criticalTag) || titleCarriesTag;
  const results: ParsedTestResult[] = [];

  for (const test of asArray(spec.tests)) {
    if (!isRecord(test)) continue;
    const attempts = asArray(test.results).filter(isRecord);
    const lastAttempt = attempts.at(-1);
    const projectName = asString(test.projectName);
    const titlePath = [suiteTitlePath, specTitle, projectName].filter(Boolean).join(" > ");
    const status = resolveResultStatus(
      asString(test.status),
      lastAttempt ? asString(lastAttempt.status) : null
    );
    const durationMs = attempts.reduce((total, attempt) => total + asNumber(attempt.duration), 0);
    const errorMessage = lastAttempt ? extractErrorMessage(lastAttempt) : null;

    results.push({
      identity: buildIdentity(asString(spec.id), file, titlePath),
      title: titlePath === "" ? specTitle : titlePath,
      status,
      durationMs: Math.round(durationMs),
      retries: Math.max(0, attempts.length - 1),
      critical,
      errorType:
        status === "TIMED_OUT" ? "TIMEOUT" : status === "FAILED" || status === "FLAKY" ? "ERROR" : null,
      errorMessage,
      attachments: lastAttempt ? extractAttachments(lastAttempt) : []
    });
  }

  return results;
};

const parseSuite = (
  suite: Record<string, unknown>,
  parentTitle: string,
  parentFile: string,
  options: ParseOptions,
  collected: ParsedSuite[]
): void => {
  const title = asString(suite.title) ?? "unnamed suite";
  const file = asString(suite.file) ?? parentFile;
  const titlePath = parentTitle === "" ? title : `${parentTitle} > ${title}`;
  const results: ParsedTestResult[] = [];

  for (const spec of asArray(suite.specs)) {
    if (!isRecord(spec)) continue;
    const specFile = asString(spec.file) ?? file;
    results.push(...parseSpec(spec, specFile, titlePath, options));
  }

  if (results.length > 0) {
    collected.push({
      title: titlePath,
      file,
      durationMs: results.reduce((total, result) => total + result.durationMs, 0),
      results
    });
  }

  for (const child of asArray(suite.suites)) {
    if (isRecord(child)) parseSuite(child, titlePath, file, options, collected);
  }
};

export class TestReportError extends Error {
  public readonly code = "TEST_REPORT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "TestReportError";
  }
}

export const parsePlaywrightJsonReport = (raw: unknown, options: ParseOptions): ParsedReport => {
  if (!isRecord(raw)) {
    throw new TestReportError("The Playwright report is not a JSON object.");
  }
  if (!Array.isArray(raw.suites)) {
    throw new TestReportError("The Playwright report does not contain a suites array.");
  }

  const suites: ParsedSuite[] = [];
  for (const suite of raw.suites) {
    if (isRecord(suite)) parseSuite(suite, "", "", options, suites);
  }

  const reportErrors: string[] = [];
  for (const error of asArray(raw.errors)) {
    if (!isRecord(error)) continue;
    const message = cleanMessage(asString(error.message));
    if (message) reportErrors.push(message);
  }

  return { suites, reportErrors };
};
