import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type {
  ArtifactType,
  ExecutionArtifact,
  ExecutionStatus,
  NormalizedTestSuite,
  TestExecutionReport,
  TestExecutionRequest,
  TestRunnerPort,
  TestSuiteKind
} from "@evidence-gate/core";
import { redactText } from "@evidence-gate/core";
import type { AllowedSuite, ExecutionPolicy } from "./policy.js";
import { assertExecutionPolicy, resolveAllowedSuite } from "./policy.js";
import type { ParsedAttachment, ParsedReport } from "./report.js";
import { TestReportError, parsePlaywrightJsonReport } from "./report.js";
import { parseVitestJsonReport } from "./report-vitest.js";
import { runProcess } from "./process.js";

export * from "./policy.js";
export * from "./report.js";
export * from "./report-vitest.js";
export * from "./process.js";
export * from "./mutation.js";
export * from "./report-stryker.js";

const REPORT_FILE_NAME = "test-report.json";
const REPORT_PATH_TOKEN = "{{reportPath}}";
const OUTPUT_FILE_NAME = "process-output.log";
const MAXIMUM_COPIED_ATTACHMENTS = 20;
const MAXIMUM_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Only these variables reach the child process; nothing else from the parent leaks. */
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

const toPosixPath = (value: string): string => value.replaceAll("\\", "/");

const classifyAttachment = (attachment: ParsedAttachment): ArtifactType => {
  const contentType = attachment.contentType ?? "";
  const name = attachment.name.toLowerCase();
  const extension = attachment.sourcePath ? extname(attachment.sourcePath).toLowerCase() : "";
  if (contentType.startsWith("image/")) return "SCREENSHOT";
  if (contentType.startsWith("video/")) return "VIDEO";
  if (name.includes("trace") || extension === ".zip") return "TRACE";
  return "OTHER";
};

const buildChildEnvironment = (reportPath: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.CI = "1";
  environment.FORCE_COLOR = "0";
  environment.PLAYWRIGHT_JSON_OUTPUT_NAME = reportPath;
  return environment;
};

export interface SubprocessTestRunnerOptions {
  policy: ExecutionPolicy;
  /** Set to false only when the policy was already validated by the caller. */
  validatePolicy?: boolean;
}

export class SubprocessTestRunner implements TestRunnerPort {
  public readonly name = "subprocess";
  private readonly policy: ExecutionPolicy;

  public constructor(options: SubprocessTestRunnerOptions) {
    this.policy =
      options.validatePolicy === false ? options.policy : assertExecutionPolicy(options.policy);
  }

  public listAllowedSuites(): { key: string; kind: TestSuiteKind }[] {
    return this.policy.suites.map((suite) => ({ key: suite.key, kind: suite.kind }));
  }

  public async run(request: TestExecutionRequest): Promise<TestExecutionReport> {
    const suite = resolveAllowedSuite(this.policy, request.suiteKey);
    const artifactDirectory = this.prepareArtifactDirectory(request.analysisId, suite.key);
    const reportPath = join(artifactDirectory, REPORT_FILE_NAME);

    const processResult = await runProcess({
      command: suite.command,
      args: suite.args.map((argument) => argument.replaceAll(REPORT_PATH_TOKEN, reportPath)),
      cwd: this.policy.workingDirectory,
      env: buildChildEnvironment(reportPath),
      timeoutMs: this.policy.timeoutMs,
      maxOutputBytes: this.policy.maxOutputBytes
    });

    const artifacts: ExecutionArtifact[] = [];
    const outputPath = join(artifactDirectory, OUTPUT_FILE_NAME);
    writeFileSync(outputPath, redactText(processResult.output), "utf8");
    artifacts.push(this.describeArtifact("PROCESS_OUTPUT", outputPath, "text/plain"));

    let suites: NormalizedTestSuite[] = [];
    let status: ExecutionStatus = processResult.timedOut ? "TIMED_OUT" : "COMPLETED";
    let errorMessage: string | null = processResult.spawnError
      ? redactText(processResult.spawnError)
      : null;

    if (processResult.spawnError) {
      status = "FAILED";
    } else if (!processResult.timedOut) {
      try {
        const parsed = this.parseReport(suite, reportPath);
        suites = parsed.suites.map((parsedSuite) => ({
          title: parsedSuite.title,
          file: parsedSuite.file,
          durationMs: parsedSuite.durationMs,
          results: parsedSuite.results.map((result) => ({
            identity: result.identity,
            title: result.title,
            status: result.status,
            durationMs: result.durationMs,
            retries: result.retries,
            critical: result.critical,
            errorType: result.errorType,
            errorMessage: result.errorMessage
          }))
        }));
        artifacts.push(this.describeArtifact("JSON_REPORT", reportPath, "application/json"));
        artifacts.push(
          ...this.copyAttachments(
            artifactDirectory,
            parsed.suites.flatMap((parsedSuite) =>
              parsedSuite.results.flatMap((result) => result.attachments)
            )
          )
        );
        if (parsed.reportErrors.length > 0) {
          errorMessage = parsed.reportErrors.join(" | ");
        }
      } catch (error) {
        status = "FAILED";
        errorMessage = redactText(
          error instanceof Error ? error.message : "The test report could not be read."
        );
      }
    }

    if (status === "COMPLETED" && processResult.exitCode !== 0 && suites.length === 0) {
      status = "FAILED";
      errorMessage ??= `The suite process exited with code ${String(processResult.exitCode)} and produced no results.`;
    }

    return {
      suiteKey: suite.key,
      kind: suite.kind,
      runner: suite.reportFormat === "vitest-json" ? "vitest" : "playwright",
      status,
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      timedOut: processResult.timedOut,
      outputTruncated: processResult.truncated,
      errorMessage,
      suites,
      artifacts
    };
  }

  private parseReport(suite: AllowedSuite, reportPath: string): ParsedReport {
    const raw = this.readReport(reportPath);
    if (suite.reportFormat === "vitest-json") {
      return parseVitestJsonReport(raw, {
        criticalByDefault: suite.critical,
        workingDirectory: this.policy.workingDirectory
      });
    }
    return parsePlaywrightJsonReport(raw, { criticalByDefault: suite.critical });
  }

  private prepareArtifactDirectory(analysisId: string, suiteKey: string): string {
    const directory = resolve(this.policy.artifactsRoot, analysisId, suiteKey);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private readReport(reportPath: string): unknown {
    let raw: string;
    try {
      raw = readFileSync(reportPath, "utf8");
    } catch {
      throw new TestReportError(
        "The suite finished without producing the expected JSON report."
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new TestReportError("The JSON report produced by the suite is not valid JSON.");
    }
  }

  private describeArtifact(
    type: ArtifactType,
    absolutePath: string,
    contentType: string | null
  ): ExecutionArtifact {
    let sizeBytes: number;
    try {
      sizeBytes = statSync(absolutePath).size;
    } catch {
      sizeBytes = 0;
    }
    return {
      type,
      path: toPosixPath(relative(this.policy.artifactsRoot, absolutePath)),
      sizeBytes,
      contentType
    };
  }

  private copyAttachments(
    artifactDirectory: string,
    attachments: readonly ParsedAttachment[]
  ): ExecutionArtifact[] {
    const destinationRoot = join(artifactDirectory, "attachments");
    const copied: ExecutionArtifact[] = [];
    let totalBytes = 0;

    for (const attachment of attachments) {
      if (copied.length >= MAXIMUM_COPIED_ATTACHMENTS) break;
      if (!attachment.sourcePath) continue;

      let size: number;
      try {
        const stats = statSync(attachment.sourcePath);
        if (!stats.isFile()) continue;
        size = stats.size;
      } catch {
        continue;
      }
      if (totalBytes + size > MAXIMUM_ATTACHMENT_BYTES) continue;

      const fileName = `${String(copied.length)}-${basename(attachment.sourcePath)}`;
      const destination = join(destinationRoot, fileName);
      try {
        mkdirSync(destinationRoot, { recursive: true });
        copyFileSync(attachment.sourcePath, destination);
      } catch {
        continue;
      }
      totalBytes += size;
      copied.push(
        this.describeArtifact(classifyAttachment(attachment), destination, attachment.contentType)
      );
    }

    return copied;
  }
}
