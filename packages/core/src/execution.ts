/**
 * Asynchronous analysis lifecycle and the port through which the domain asks for a
 * controlled test execution. The domain never knows Playwright, Prisma or a shell.
 */

export const ANALYSIS_STATUSES = [
  "PENDING",
  "ANALYZING",
  "SELECTING_TESTS",
  "EXECUTING",
  "CALCULATING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT"
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Stages executed by the worker, in order. Each one is idempotent and resumable. */
export const WORKER_STAGES = [
  "ANALYZING",
  "SELECTING_TESTS",
  "EXECUTING",
  "CALCULATING"
] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

export const TERMINAL_ANALYSIS_STATUSES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT"
] as const satisfies readonly AnalysisStatus[];

export const isTerminalAnalysisStatus = (status: AnalysisStatus): boolean =>
  (TERMINAL_ANALYSIS_STATUSES as readonly AnalysisStatus[]).includes(status);

export const JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TEST_SUITE_KINDS = ["SMOKE", "REGRESSION", "API"] as const;
export type TestSuiteKind = (typeof TEST_SUITE_KINDS)[number];

export const TEST_STATUSES = ["PASSED", "FAILED", "SKIPPED", "TIMED_OUT", "FLAKY"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const TEST_SELECTION_STRATEGIES = [
  "SMOKE",
  "SMOKE_AND_RELATED",
  "PARTIAL_REGRESSION_AND_API",
  "FULL_REGRESSION_AND_API"
] as const;
export type TestSelectionStrategy = (typeof TEST_SELECTION_STRATEGIES)[number];

export interface TestSelection {
  strategy: TestSelectionStrategy;
  suiteKeys: string[];
  reason: string;
}

export const EXECUTION_STATUSES = ["COMPLETED", "FAILED", "TIMED_OUT"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const ARTIFACT_TYPES = [
  "JSON_REPORT",
  "PROCESS_OUTPUT",
  "SCREENSHOT",
  "VIDEO",
  "TRACE",
  "OTHER"
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ExecutionArtifact {
  type: ArtifactType;
  /** Path relative to the configured artifacts root, never an absolute host path. */
  path: string;
  sizeBytes: number;
  contentType: string | null;
}

export interface NormalizedTestResult {
  /** Stable identity used to follow the same test across executions. */
  identity: string;
  title: string;
  status: TestStatus;
  durationMs: number;
  retries: number;
  critical: boolean;
  errorType: string | null;
  errorMessage: string | null;
}

export interface NormalizedTestSuite {
  title: string;
  file: string;
  durationMs: number;
  results: NormalizedTestResult[];
}

export interface TestExecutionReport {
  suiteKey: string;
  kind: TestSuiteKind;
  runner: string;
  status: ExecutionStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  errorMessage: string | null;
  suites: NormalizedTestSuite[];
  artifacts: ExecutionArtifact[];
}

export interface TestExecutionRequest {
  analysisId: string;
  suiteKey: string;
}

/** Port implemented by execution adapters such as `@evidence-gate/test-runner`. */
export interface TestRunnerPort {
  readonly name: string;
  /** Suite keys this runner is allowed to execute, resolved from configuration. */
  listAllowedSuites(): { key: string; kind: TestSuiteKind }[];
  run(request: TestExecutionRequest): Promise<TestExecutionReport>;
}

export const countByStatus = (
  suites: readonly NormalizedTestSuite[]
): Record<TestStatus, number> => {
  const totals: Record<TestStatus, number> = {
    PASSED: 0,
    FAILED: 0,
    SKIPPED: 0,
    TIMED_OUT: 0,
    FLAKY: 0
  };
  for (const suite of suites) {
    for (const result of suite.results) {
      totals[result.status] += 1;
    }
  }
  return totals;
};
