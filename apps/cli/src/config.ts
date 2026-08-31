import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { TestSuiteKind } from "@evidence-gate/core";
import { TEST_SUITE_KINDS } from "@evidence-gate/core";
import type { CriticalityRule } from "@evidence-gate/git-analyzer";
import type { QualityEvidence } from "@evidence-gate/quality-engine";
import type { RiskMetrics } from "@evidence-gate/risk-engine";
import type { AllowedSuite, ExecutionPolicy, ReportFormat } from "@evidence-gate/test-runner";
import { ExecutionPolicyError, REPORT_FORMATS, assertExecutionPolicy } from "@evidence-gate/test-runner";
import type { ResolvedPolicies } from "./policy-overrides.js";
import { resolvePolicies } from "./policy-overrides.js";

/**
 * The project being evaluated owns this file. It is operator configuration checked
 * into that repository — nothing here comes from an HTTP payload or from a model.
 */
export interface CheckConfig {
  configPath: string;
  projectName: string;
  baseRef: string;
  criticalityRules: CriticalityRule[];
  riskMetrics: RiskMetrics;
  suppliedEvidence: Pick<
    QualityEvidence,
    | "mutationScore"
    | "coverage"
    | "mitigationCoverage"
    | "criticalSecurityIssues"
    | "survivedCriticalMutants"
  >;
  policy: ExecutionPolicy;
  policies: ResolvedPolicies;
  reportPath: string;
}

export const DEFAULT_CONFIG_FILE = "evidence-gate.config.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new ExecutionPolicyError(message);
};

const readString = (source: Record<string, unknown>, key: string, fallback?: string): string => {
  const value = source[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (fallback !== undefined) return fallback;
  return fail(`The configuration field "${key}" must be a non-empty string.`);
};

const readNumberRecord = <T extends Record<string, number>>(
  source: Record<string, unknown>,
  key: string
): T => {
  const value = source[key];
  if (value === undefined) return {} as T;
  if (!isRecord(value)) return fail(`The configuration field "${key}" must be an object.`);
  const result: Record<string, number> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "number" || !Number.isFinite(entryValue)) {
      return fail(`"${key}.${entryKey}" must be a number.`);
    }
    result[entryKey] = entryValue;
  }
  return result as T;
};

const readCriticalityRules = (source: Record<string, unknown>): CriticalityRule[] => {
  const value = source.criticalityRules;
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail('"criticalityRules" must be an array.');

  return value.map((raw, index) => {
    if (!isRecord(raw)) return fail(`criticalityRules[${String(index)}] must be an object.`);
    const businessCriticality = raw.businessCriticality;
    if (typeof businessCriticality !== "number" || businessCriticality < 0 || businessCriticality > 100) {
      return fail(`criticalityRules[${String(index)}].businessCriticality must be between 0 and 100.`);
    }
    return {
      pathPrefix: readString(raw, "pathPrefix"),
      area: readString(raw, "area"),
      businessCriticality
    };
  });
};

/**
 * Resolves the executable for a suite. Only three forms are accepted, so a config
 * file can never smuggle a shell command: the literal "node" (the running Node
 * binary), an absolute path, or a path relative to the working directory.
 */
const resolveCommand = (command: string, workingDirectory: string): string => {
  if (command === "node") return process.execPath;
  if (isAbsolute(command)) return command;
  if (command.includes("..")) {
    return fail(`The command "${command}" must not traverse upwards; use an absolute path.`);
  }
  return resolve(workingDirectory, command);
};

const readSuites = (source: Record<string, unknown>, workingDirectory: string): AllowedSuite[] => {
  const value = source.suites;
  if (!Array.isArray(value) || value.length === 0) {
    return fail('"execution.suites" must declare at least one suite.');
  }

  return value.map((raw, index) => {
    if (!isRecord(raw)) return fail(`suites[${String(index)}] must be an object.`);

    const kind = readString(raw, "kind");
    if (!(TEST_SUITE_KINDS as readonly string[]).includes(kind)) {
      return fail(
        `suites[${String(index)}].kind must be one of ${TEST_SUITE_KINDS.join(", ")}; received "${kind}".`
      );
    }

    const reportFormat = raw.reportFormat ?? "playwright-json";
    if (typeof reportFormat !== "string" || !(REPORT_FORMATS as readonly string[]).includes(reportFormat)) {
      return fail(
        `suites[${String(index)}].reportFormat must be one of ${REPORT_FORMATS.join(", ")}.`
      );
    }

    const args = raw.args ?? [];
    if (!Array.isArray(args)) return fail(`suites[${String(index)}].args must be an array.`);

    return {
      key: readString(raw, "key"),
      kind: kind as TestSuiteKind,
      command: resolveCommand(readString(raw, "command"), workingDirectory),
      args: args.map((argument, argumentIndex) => {
        if (typeof argument !== "string") {
          return fail(`suites[${String(index)}].args[${String(argumentIndex)}] must be a string.`);
        }
        return argument;
      }),
      critical: raw.critical === true,
      reportFormat: reportFormat as ReportFormat
    };
  });
};

export interface LoadConfigOptions {
  /** Directory the CLI was pointed at; relative paths resolve against it. */
  cwd: string;
  configPath?: string;
  reportPath?: string;
}

export const loadCheckConfig = (options: LoadConfigOptions): CheckConfig => {
  const configPath = resolve(options.cwd, options.configPath ?? DEFAULT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return fail(
      `Configuration file not found at ${configPath}. Create a ${DEFAULT_CONFIG_FILE} or pass --config <path>.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    return fail(
      `${configPath} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  if (!isRecord(raw)) return fail(`${configPath} must contain a JSON object.`);

  const configRoot = dirname(configPath);
  const execution = isRecord(raw.execution) ? raw.execution : {};
  const workingDirectory = resolve(configRoot, readString(execution, "workingDirectory", "."));
  const artifactsRoot = resolve(
    configRoot,
    readString(execution, "artifactsRoot", ".evidence-gate/artifacts")
  );
  mkdirSync(artifactsRoot, { recursive: true });

  const timeoutMs = typeof execution.timeoutMs === "number" ? execution.timeoutMs : 600_000;
  const maxOutputBytes =
    typeof execution.maxOutputBytes === "number" ? execution.maxOutputBytes : 1_048_576;

  return {
    configPath,
    projectName: readString(raw, "project", "unnamed project"),
    baseRef: readString(raw, "baseRef", "origin/main"),
    criticalityRules: readCriticalityRules(raw),
    riskMetrics: readNumberRecord<Record<string, number>>(raw, "riskMetrics") as RiskMetrics,
    suppliedEvidence: readNumberRecord<Record<string, number>>(raw, "suppliedEvidence"),
    policies: resolvePolicies(raw),
    policy: assertExecutionPolicy({
      workingDirectory,
      artifactsRoot,
      timeoutMs,
      maxOutputBytes,
      suites: readSuites(execution, workingDirectory)
    }),
    reportPath: resolve(configRoot, options.reportPath ?? "evidence-gate-report.html")
  };
};
