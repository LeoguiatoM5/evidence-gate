import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { TestSuiteKind } from "@qualityguard/core";
import { TEST_SUITE_KINDS } from "@qualityguard/core";

/**
 * An execution policy is operator configuration, never payload. Nothing in an HTTP
 * request can add a command, an argument or a directory to this allow list.
 */
/** Report formats the runner knows how to normalise. */
export const REPORT_FORMATS = ["playwright-json", "vitest-json"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface AllowedSuite {
  key: string;
  kind: TestSuiteKind;
  /** Absolute path of the executable. Resolved and validated at load time. */
  command: string;
  /** The token {{reportPath}} is replaced by the runner-owned report destination. */
  args: string[];
  /** Marks suites whose failures block a release regardless of the score. */
  critical: boolean;
  reportFormat: ReportFormat;
}

export interface ExecutionPolicy {
  workingDirectory: string;
  artifactsRoot: string;
  timeoutMs: number;
  maxOutputBytes: number;
  suites: AllowedSuite[];
}

const SUITE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;
const MAXIMUM_ARGUMENT_LENGTH = 500;
const MAXIMUM_ARGUMENTS = 50;

export class ExecutionPolicyError extends Error {
  public readonly code = "EXECUTION_POLICY_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

export const isInside = (parent: string, child: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

const assertDirectory = (label: string, path: string): void => {
  if (!isAbsolute(path)) {
    throw new ExecutionPolicyError(`${label} must be an absolute path; received "${path}".`);
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new ExecutionPolicyError(`${label} does not exist: "${path}".`);
  }
  if (!stats.isDirectory()) {
    throw new ExecutionPolicyError(`${label} is not a directory: "${path}".`);
  }
};

const assertExecutable = (suiteKey: string, command: string): void => {
  if (!isAbsolute(command)) {
    throw new ExecutionPolicyError(
      `Suite "${suiteKey}" must declare an absolute command; received "${command}".`
    );
  }
  try {
    accessSync(command, constants.X_OK);
  } catch {
    throw new ExecutionPolicyError(
      `Suite "${suiteKey}" points to a command that is missing or not executable: "${command}".`
    );
  }
};

/** Validates the policy eagerly so an invalid configuration fails before any job runs. */
export const assertExecutionPolicy = (policy: ExecutionPolicy): ExecutionPolicy => {
  assertDirectory("workingDirectory", policy.workingDirectory);
  assertDirectory("artifactsRoot", policy.artifactsRoot);

  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new ExecutionPolicyError("timeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(policy.maxOutputBytes) || policy.maxOutputBytes <= 0) {
    throw new ExecutionPolicyError("maxOutputBytes must be a positive integer.");
  }
  if (policy.suites.length === 0) {
    throw new ExecutionPolicyError("At least one suite must be allowed.");
  }

  const seen = new Set<string>();
  for (const suite of policy.suites) {
    if (!SUITE_KEY_PATTERN.test(suite.key)) {
      throw new ExecutionPolicyError(
        `Suite key "${suite.key}" must be lowercase alphanumeric with dashes.`
      );
    }
    if (seen.has(suite.key)) {
      throw new ExecutionPolicyError(`Suite key "${suite.key}" is declared more than once.`);
    }
    seen.add(suite.key);

    if (!(TEST_SUITE_KINDS as readonly string[]).includes(suite.kind)) {
      throw new ExecutionPolicyError(
        `Suite "${suite.key}" declares an unknown kind "${suite.kind}".`
      );
    }
    if (!(REPORT_FORMATS as readonly string[]).includes(suite.reportFormat)) {
      throw new ExecutionPolicyError(
        `Suite "${suite.key}" declares an unknown reportFormat "${suite.reportFormat}"; expected one of ${REPORT_FORMATS.join(", ")}.`
      );
    }
    assertExecutable(suite.key, suite.command);

    if (suite.args.length > MAXIMUM_ARGUMENTS) {
      throw new ExecutionPolicyError(`Suite "${suite.key}" declares too many arguments.`);
    }
    for (const argument of suite.args) {
      if (typeof argument !== "string" || argument.length > MAXIMUM_ARGUMENT_LENGTH) {
        throw new ExecutionPolicyError(
          `Suite "${suite.key}" declares an invalid argument; arguments must be short strings.`
        );
      }
    }
  }

  return policy;
};

export class SuiteNotAllowedError extends Error {
  public readonly code = "SUITE_NOT_ALLOWED";

  public constructor(suiteKey: string) {
    super(`Suite "${suiteKey}" is not present in the execution allow list.`);
    this.name = "SuiteNotAllowedError";
  }
}

export const resolveAllowedSuite = (policy: ExecutionPolicy, suiteKey: string): AllowedSuite => {
  const suite = policy.suites.find((candidate) => candidate.key === suiteKey);
  if (!suite) throw new SuiteNotAllowedError(suiteKey);
  return suite;
};
