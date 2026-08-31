import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { TestSuiteKind } from "@qualityguard/core";
import { TEST_SUITE_KINDS } from "@qualityguard/core";
import type { AllowedSuite, ExecutionPolicy, ReportFormat } from "@qualityguard/test-runner";
import { ExecutionPolicyError, REPORT_FORMATS, assertExecutionPolicy } from "@qualityguard/test-runner";

/**
 * Everything the worker is allowed to execute comes from this operator-owned file.
 * No HTTP payload contributes a command, an argument or a directory.
 */
export interface WorkerConfig {
  owner: string;
  leaseMs: number;
  pollIntervalMs: number;
  retryBackoffMs: number;
  policy: ExecutionPolicy;
}

const DEFAULTS = {
  leaseMs: 120_000,
  pollIntervalMs: 2_000,
  retryBackoffMs: 5_000,
  timeoutMs: 900_000,
  maxOutputBytes: 1_048_576
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const requireString = (source: Record<string, unknown>, key: string): string => {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ExecutionPolicyError(`The execution policy field "${key}" must be a non-empty string.`);
  }
  return value;
};

const parseSuite = (raw: unknown, index: number): AllowedSuite => {
  if (!isRecord(raw)) {
    throw new ExecutionPolicyError(`Suite #${String(index)} in the execution policy is not an object.`);
  }
  const kind = requireString(raw, "kind");
  if (!(TEST_SUITE_KINDS as readonly string[]).includes(kind)) {
    throw new ExecutionPolicyError(
      `Suite #${String(index)} declares an unknown kind "${kind}"; expected one of ${TEST_SUITE_KINDS.join(", ")}.`
    );
  }
  const reportFormat = raw.reportFormat ?? "playwright-json";
  if (typeof reportFormat !== "string" || !(REPORT_FORMATS as readonly string[]).includes(reportFormat)) {
    throw new ExecutionPolicyError(
      `Suite #${String(index)} declares an unknown reportFormat; expected one of ${REPORT_FORMATS.join(", ")}.`
    );
  }
  const args = raw.args;
  if (args !== undefined && !Array.isArray(args)) {
    throw new ExecutionPolicyError(`Suite #${String(index)} declares "args" that is not an array.`);
  }

  return {
    key: requireString(raw, "key"),
    kind: kind as TestSuiteKind,
    command: resolve(requireString(raw, "command")),
    args: (args ?? []).map((argument, argumentIndex) => {
      if (typeof argument !== "string") {
        throw new ExecutionPolicyError(
          `Suite #${String(index)} argument #${String(argumentIndex)} is not a string.`
        );
      }
      return argument;
    }),
    critical: raw.critical === true,
    reportFormat: reportFormat as ReportFormat
  };
};

export const parseExecutionPolicy = (raw: unknown, env: NodeJS.ProcessEnv): ExecutionPolicy => {
  if (!isRecord(raw)) {
    throw new ExecutionPolicyError("The execution policy file must contain a JSON object.");
  }
  const suites = raw.suites;
  if (!Array.isArray(suites)) {
    throw new ExecutionPolicyError('The execution policy must declare a "suites" array.');
  }

  return assertExecutionPolicy({
    workingDirectory: resolve(requireString(raw, "workingDirectory")),
    artifactsRoot: resolve(requireString(raw, "artifactsRoot")),
    timeoutMs: readInteger(
      env.QG_EXECUTION_TIMEOUT_MS,
      typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULTS.timeoutMs
    ),
    maxOutputBytes: readInteger(
      env.QG_MAX_OUTPUT_BYTES,
      typeof raw.maxOutputBytes === "number" ? raw.maxOutputBytes : DEFAULTS.maxOutputBytes
    ),
    suites: suites.map(parseSuite)
  });
};

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => {
  const policyPath = env.QG_EXECUTION_POLICY_FILE;
  if (!policyPath) {
    throw new ExecutionPolicyError(
      "QG_EXECUTION_POLICY_FILE is not set; the worker refuses to run without an explicit execution allow list."
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(policyPath), "utf8")) as unknown;
  } catch (error) {
    throw new ExecutionPolicyError(
      `The execution policy file could not be read: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  return {
    owner: env.QG_WORKER_ID ?? `${hostname()}-${String(process.pid)}`,
    leaseMs: readInteger(env.QG_WORKER_LEASE_MS, DEFAULTS.leaseMs),
    pollIntervalMs: readInteger(env.QG_WORKER_POLL_MS, DEFAULTS.pollIntervalMs),
    retryBackoffMs: readInteger(env.QG_WORKER_RETRY_BACKOFF_MS, DEFAULTS.retryBackoffMs),
    policy: parseExecutionPolicy(raw, env)
  };
};
