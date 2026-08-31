import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  MutationExecutionReport,
  MutationRunRequest,
  MutationRunnerPort
} from "@evidence-gate/core";
import { redactText } from "@evidence-gate/core";
import { ExecutionPolicyError, isInside } from "./policy.js";
import { runProcess } from "./process.js";
import { TestReportError } from "./report.js";
import { parseStrykerReport } from "./report-stryker.js";

/**
 * Runs an allow-listed mutation testing command and normalises its report. Same
 * execution rules as the test runner: no shell, absolute command, hard timeout,
 * bounded output, and nothing from a payload ever becomes a command.
 */

const OUTPUT_FILE_NAME = "mutation-output.log";
const REPORT_COPY_NAME = "mutation-report.json";

export interface MutationPolicy {
  workingDirectory: string;
  artifactsRoot: string;
  /** Absolute path of the executable. */
  command: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /**
   * Where the tool writes its report, relative to workingDirectory. StrykerJS
   * decides this through its own configuration, so the project declares it here
   * instead of the runner guessing.
   */
  reportPath: string;
}

const INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "NUMBER_OF_PROCESSORS"
] as const;

const buildChildEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.CI = "1";
  environment.FORCE_COLOR = "0";
  return environment;
};

const toPosixPath = (value: string): string => value.replaceAll("\\", "/");

export const assertMutationPolicy = (policy: MutationPolicy): MutationPolicy => {
  if (!isAbsolute(policy.command)) {
    throw new ExecutionPolicyError(
      `The mutation command must be an absolute path; received "${policy.command}".`
    );
  }
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new ExecutionPolicyError("The mutation timeoutMs must be a positive integer.");
  }
  if (policy.reportPath.trim() === "") {
    throw new ExecutionPolicyError("The mutation reportPath must not be empty.");
  }
  const reportLocation = resolve(policy.workingDirectory, policy.reportPath);
  if (!isInside(policy.workingDirectory, reportLocation)) {
    throw new ExecutionPolicyError(
      "The mutation reportPath must stay inside the working directory."
    );
  }
  return policy;
};

export class StrykerMutationRunner implements MutationRunnerPort {
  public readonly name = "stryker";
  private readonly policy: MutationPolicy;

  public constructor(policy: MutationPolicy, options: { validate?: boolean } = {}) {
    this.policy = options.validate === false ? policy : assertMutationPolicy(policy);
  }

  public async run(request: MutationRunRequest): Promise<MutationExecutionReport> {
    const artifactDirectory = resolve(this.policy.artifactsRoot, request.analysisId, "mutation");
    mkdirSync(artifactDirectory, { recursive: true });

    const processResult = await runProcess({
      command: this.policy.command,
      args: this.policy.args,
      cwd: this.policy.workingDirectory,
      env: buildChildEnvironment(),
      timeoutMs: this.policy.timeoutMs,
      maxOutputBytes: this.policy.maxOutputBytes
    });

    const artifacts: MutationExecutionReport["artifacts"] = [];
    const outputPath = join(artifactDirectory, OUTPUT_FILE_NAME);
    writeFileSync(outputPath, redactText(processResult.output), "utf8");
    artifacts.push(this.describeArtifact("PROCESS_OUTPUT", outputPath));

    if (processResult.spawnError) {
      return this.failure(processResult, artifacts, redactText(processResult.spawnError));
    }
    if (processResult.timedOut) {
      return {
        status: "TIMED_OUT",
        exitCode: processResult.exitCode,
        durationMs: processResult.durationMs,
        timedOut: true,
        outputTruncated: processResult.truncated,
        errorMessage: "The mutation run exceeded the configured timeout.",
        mutation: null,
        artifacts
      };
    }

    const reportLocation = resolve(this.policy.workingDirectory, this.policy.reportPath);
    let mutation;
    try {
      mutation = parseStrykerReport(this.readReport(reportLocation), {
        criticalPathPrefixes: request.criticalPathPrefixes
      });
    } catch (error) {
      return this.failure(
        processResult,
        artifacts,
        redactText(error instanceof Error ? error.message : "The mutation report could not be read.")
      );
    }

    try {
      const copied = join(artifactDirectory, REPORT_COPY_NAME);
      copyFileSync(reportLocation, copied);
      artifacts.push(this.describeArtifact("MUTATION_REPORT", copied));
    } catch {
      // The report was parsed; failing to keep a copy is not a reason to reject it.
    }

    return {
      status: "COMPLETED",
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      timedOut: false,
      outputTruncated: processResult.truncated,
      errorMessage: null,
      mutation,
      artifacts
    };
  }

  private failure(
    processResult: { exitCode: number | null; durationMs: number; truncated: boolean },
    artifacts: MutationExecutionReport["artifacts"],
    message: string
  ): MutationExecutionReport {
    return {
      status: "FAILED",
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      timedOut: false,
      outputTruncated: processResult.truncated,
      errorMessage: message,
      mutation: null,
      artifacts
    };
  }

  private readReport(reportPath: string): unknown {
    let raw: string;
    try {
      raw = readFileSync(reportPath, "utf8");
    } catch {
      throw new TestReportError(
        `The mutation run finished without producing a report at ${this.policy.reportPath}.`
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new TestReportError("The mutation report is not valid JSON.");
    }
  }

  private describeArtifact(
    type: string,
    absolutePath: string
  ): MutationExecutionReport["artifacts"][number] {
    let sizeBytes: number;
    try {
      sizeBytes = statSync(absolutePath).size;
    } catch {
      sizeBytes = 0;
    }
    return {
      type,
      path: toPosixPath(relative(this.policy.artifactsRoot, absolutePath)),
      sizeBytes
    };
  }
}
