import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  RepositoryAnalysis,
  TestExecutionReport,
  TestExecutionRequest,
  TestRunnerPort,
  TestSuiteKind
} from "@qualityguard/core";
import {
  JobQueue,
  WorkerAnalysisRepository,
  createPrismaClient,
  type QualityGuardPrismaClient
} from "@qualityguard/persistence-prisma";
import { SubprocessTestRunner, type ExecutionPolicy } from "@qualityguard/test-runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/helpers/database.js";
import { AnalysisPipeline } from "./pipeline.js";
import { AnalysisWorker } from "./worker.js";

const testRoot = resolve(process.cwd(), ".tmp", "worker-integration-tests", randomUUID());
const scriptsRoot = resolve(testRoot, "scripts");
const artifactsRoot = resolve(testRoot, "artifacts");

const buildReportSource = (critical: "passing" | "failing"): string => `
const { writeFileSync } = require("node:fs");
const failing = ${critical === "failing" ? "true" : "false"};
const report = {
  suites: [
    {
      title: "smoke.spec.ts",
      file: "tests/smoke.spec.ts",
      specs: [
        {
          title: "keeps the payment limit @critical",
          id: "spec-limit",
          file: "tests/smoke.spec.ts",
          tags: ["@critical"],
          tests: [
            {
              projectName: "chromium",
              status: failing ? "unexpected" : "expected",
              results: [
                failing
                  ? { status: "failed", duration: 50, attachments: [], error: { message: "limit regression" } }
                  : { status: "passed", duration: 50, attachments: [] }
              ]
            }
          ]
        },
        {
          title: "loads the cart",
          id: "spec-cart",
          file: "tests/smoke.spec.ts",
          tags: [],
          tests: [
            {
              projectName: "chromium",
              status: "expected",
              results: [{ status: "passed", duration: 30, attachments: [] }]
            }
          ]
        }
      ]
    }
  ],
  errors: []
};
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report), "utf8");
process.exit(failing ? 1 : 0);
`;

const hangingSource = `setInterval(() => {}, 1000);`;

let passingScript = "";
let failingScript = "";
let hangingScript = "";

const buildPolicy = (script: string, timeoutMs = 20_000): ExecutionPolicy => ({
  workingDirectory: scriptsRoot,
  artifactsRoot,
  timeoutMs,
  maxOutputBytes: 64 * 1024,
  suites: [
    {
      key: "smoke-suite",
      kind: "SMOKE" as TestSuiteKind,
      command: process.execPath,
      args: [script],
      critical: false,
      reportFormat: "playwright-json"
    }
  ]
});

/** Controllable runner used to reproduce crashes and resumes deterministically. */
class ScriptedRunner implements TestRunnerPort {
  public readonly name = "scripted";
  public calls = 0;

  public constructor(private readonly behaviours: ("crash" | "pass")[]) {}

  public listAllowedSuites(): { key: string; kind: TestSuiteKind }[] {
    return [{ key: "smoke-suite", kind: "SMOKE" }];
  }

  public run(request: TestExecutionRequest): Promise<TestExecutionReport> {
    const behaviour = this.behaviours[this.calls] ?? "pass";
    this.calls += 1;
    if (behaviour === "crash") {
      return Promise.reject(new Error("the runner process crashed"));
    }
    return Promise.resolve({
      suiteKey: request.suiteKey,
      kind: "SMOKE",
      runner: this.name,
      status: "COMPLETED",
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
      outputTruncated: false,
      errorMessage: null,
      suites: [
        {
          title: "smoke.spec.ts",
          file: "tests/smoke.spec.ts",
          durationMs: 10,
          results: [
            {
              identity: "spec-limit",
              title: "keeps the payment limit",
              status: "PASSED",
              durationMs: 10,
              retries: 0,
              critical: true,
              errorType: null,
              errorMessage: null
            }
          ]
        }
      ],
      artifacts: []
    });
  }
}

const repositoryAnalysis = (suffix: string): RepositoryAnalysis => ({
  diffHash: `diff-hash-${suffix}`,
  changes: [
    {
      path: "src/payment/limit.ts",
      oldPath: null,
      type: "MODIFIED",
      additions: 1,
      deletions: 1,
      extension: "ts",
      area: "Payments",
      businessCriticality: 90
    }
  ],
  affectedAreas: ["Payments"],
  totalAdditions: 1,
  totalDeletions: 1,
  totalChangedLines: 2
});

interface Harness {
  prisma: QualityGuardPrismaClient;
  repository: WorkerAnalysisRepository;
  queue: JobQueue;
  analysisId: string;
  close: () => Promise<void>;
}

const databases: TestDatabase[] = [];

const seedPendingAnalysis = async (
  suffix: string,
  maxAttempts = 1
): Promise<Harness> => {
  const database = createTestDatabase("worker-integration-tests");
  databases.push(database);
  const prisma = createPrismaClient(database.url);
  const repository = new WorkerAnalysisRepository(prisma);
  const queue = new JobQueue(prisma);

  const created = await repository.createPending({
    project: { name: "QualityGuard Demo", slug: "qualityguard-demo" },
    repository: {
      name: "checkout-service",
      provider: "LOCAL",
      branch: "feature/payment-limit",
      headSha: `sha-${suffix}`
    },
    idempotencyKey: `key-${suffix}`,
    policyVersion: "risk-v1+quality-v1",
    repositoryAnalysis: repositoryAnalysis(suffix),
    riskMetrics: {
      bugCount: 0,
      coverage: 95,
      mutationScore: 90,
      previousFailureRate: 0,
      changesLast90Days: 1,
      relatedTests: 5
    },
    suppliedEvidence: {
      coverage: 95,
      mutationScore: 90,
      mitigationCoverage: 100,
      criticalSecurityIssues: 0,
      survivedCriticalMutants: 0
    },
    maxAttempts
  });

  return {
    prisma,
    repository,
    queue,
    analysisId: created.analysisId,
    close: async () => {
      await prisma.$disconnect();
    }
  };
};

const buildWorker = (
  harness: Harness,
  runner: TestRunnerPort,
  overrides: { leaseMs?: number } = {}
): AnalysisWorker =>
  new AnalysisWorker({
    queue: harness.queue,
    repository: harness.repository,
    pipeline: new AnalysisPipeline({ repository: harness.repository, runner }),
    owner: "worker-under-test",
    leaseMs: overrides.leaseMs ?? 60_000,
    pollIntervalMs: 10,
    retryBackoffMs: 0
  });

beforeAll(() => {
  mkdirSync(scriptsRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  passingScript = resolve(scriptsRoot, "passing.cjs");
  failingScript = resolve(scriptsRoot, "failing.cjs");
  hangingScript = resolve(scriptsRoot, "hanging.cjs");
  writeFileSync(passingScript, buildReportSource("passing"), "utf8");
  writeFileSync(failingScript, buildReportSource("failing"), "utf8");
  writeFileSync(hangingScript, hangingSource, "utf8");
});

afterEach(() => {
  for (const database of databases.splice(0)) database.remove();
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("analysis worker", () => {
  it("drives a queued analysis through every stage and persists real execution evidence", async () => {
    const harness = await seedPendingAnalysis("success");
    const runner = new SubprocessTestRunner({ policy: buildPolicy(passingScript) });

    try {
      const tick = await buildWorker(harness, runner).runOnce();
      expect(tick.processed).toBe(true);
      expect(tick.status).toBe("COMPLETED");

      const analysis = await harness.prisma.analysis.findUniqueOrThrow({
        where: { id: harness.analysisId },
        include: {
          stages: true,
          job: true,
          riskAssessment: true,
          testSelection: true,
          qualityScore: true,
          qualityGate: true,
          executions: { include: { suites: { include: { results: true } }, artifacts: true } }
        }
      });

      expect(analysis.status).toBe("COMPLETED");
      expect(analysis.job?.status).toBe("SUCCEEDED");
      expect(analysis.stages.map((stage) => stage.name).sort()).toEqual([
        "ANALYZING",
        "CALCULATING",
        "EXECUTING",
        "SELECTING_TESTS"
      ]);
      expect(analysis.stages.every((stage) => stage.status === "COMPLETED")).toBe(true);
      expect(analysis.riskAssessment?.level).toBeTruthy();
      expect(analysis.testSelection?.suiteKeys).toEqual(["smoke-suite"]);

      const execution = analysis.executions[0];
      expect(execution?.status).toBe("COMPLETED");
      expect(execution?.suiteKey).toBe("smoke-suite");
      expect(execution?.suites[0]?.results).toHaveLength(2);
      expect(execution?.artifacts.map((artifact) => artifact.type)).toContain("JSON_REPORT");

      expect(analysis.qualityScore?.score).toBeGreaterThan(0);
      expect(analysis.qualityGate?.decision).not.toBe("RELEASE_BLOCKED");
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("blocks the release when an executed critical test fails", async () => {
    const harness = await seedPendingAnalysis("critical-failure");
    const runner = new SubprocessTestRunner({ policy: buildPolicy(failingScript) });

    try {
      const tick = await buildWorker(harness, runner).runOnce();
      expect(tick.status).toBe("COMPLETED");

      const gate = await harness.prisma.qualityGate.findUniqueOrThrow({
        where: { analysisId: harness.analysisId }
      });
      expect(gate.decision).toBe("RELEASE_BLOCKED");
      expect(JSON.stringify(gate.reasons)).toContain("CRITICAL_TEST_FAILURE");
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("times out a suite that never finishes and never fabricates evidence", async () => {
    const harness = await seedPendingAnalysis("timeout");
    const runner = new SubprocessTestRunner({ policy: buildPolicy(hangingScript, 1200) });

    try {
      const tick = await buildWorker(harness, runner).runOnce();
      expect(tick.status).toBe("TIMED_OUT");

      const analysis = await harness.prisma.analysis.findUniqueOrThrow({
        where: { id: harness.analysisId },
        include: { job: true, stages: true, qualityGate: true, executions: true }
      });
      expect(analysis.status).toBe("TIMED_OUT");
      expect(analysis.job?.status).toBe("FAILED");
      expect(analysis.job?.lastErrorCode).toBe("EXECUTION_TIMED_OUT");
      expect(analysis.executions[0]?.timedOut).toBe(true);
      expect(analysis.qualityGate).toBeNull();
      expect(
        analysis.stages.find((stage) => stage.name === "EXECUTING")?.status
      ).toBe("FAILED");
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("keeps a single job per analysis and never leases the same job twice", async () => {
    const harness = await seedPendingAnalysis("duplicate");

    try {
      const first = await harness.queue.enqueue(harness.analysisId);
      const second = await harness.queue.enqueue(harness.analysisId);
      expect(second.id).toBe(first.id);
      expect(await harness.prisma.analysisJob.count({ where: { analysisId: harness.analysisId } })).toBe(1);

      const leased = await harness.queue.leaseNext("worker-a", 60_000);
      expect(leased?.id).toBe(first.id);
      expect(await harness.queue.leaseNext("worker-b", 60_000)).toBeNull();
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("retries a crashed run and resumes without repeating completed stages", async () => {
    const harness = await seedPendingAnalysis("resume", 2);
    const runner = new ScriptedRunner(["crash", "pass"]);
    const worker = buildWorker(harness, runner);

    try {
      const firstTick = await worker.runOnce();
      expect(firstTick.status).toBe("PENDING");
      expect(firstTick.requeued).toBe(true);

      const afterCrash = await harness.prisma.analysis.findUniqueOrThrow({
        where: { id: harness.analysisId },
        include: { stages: true, job: true }
      });
      expect(afterCrash.job?.status).toBe("QUEUED");
      expect(afterCrash.job?.lastErrorCode).toBe("STAGE_UNEXPECTED_ERROR");
      expect(afterCrash.stages.find((stage) => stage.name === "ANALYZING")?.status).toBe("COMPLETED");
      expect(afterCrash.stages.find((stage) => stage.name === "EXECUTING")?.status).toBe("FAILED");

      const secondTick = await worker.runOnce();
      expect(secondTick.status).toBe("COMPLETED");

      const afterResume = await harness.prisma.analysis.findUniqueOrThrow({
        where: { id: harness.analysisId },
        include: { stages: true, job: true, executions: true }
      });
      expect(afterResume.status).toBe("COMPLETED");
      expect(afterResume.job?.status).toBe("SUCCEEDED");
      expect(afterResume.job?.attempts).toBe(2);
      expect(afterResume.executions).toHaveLength(1);
      expect(runner.calls).toBe(2);
      // The stages that already succeeded are not executed again on the retry.
      expect(afterResume.stages.find((stage) => stage.name === "ANALYZING")?.attempts).toBe(1);
      expect(afterResume.stages.find((stage) => stage.name === "SELECTING_TESTS")?.attempts).toBe(1);
      expect(afterResume.stages.find((stage) => stage.name === "EXECUTING")?.attempts).toBe(2);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("recovers a job whose worker died while holding the lease", async () => {
    const harness = await seedPendingAnalysis("expired-lease", 2);
    const runner = new ScriptedRunner(["pass"]);

    try {
      const job = await harness.prisma.analysisJob.findFirstOrThrow({
        where: { analysisId: harness.analysisId }
      });
      await harness.prisma.analysisJob.update({
        where: { id: job.id },
        data: {
          status: "RUNNING",
          attempts: 1,
          leaseOwner: "dead-worker",
          leaseExpiresAt: new Date(Date.now() - 60_000)
        }
      });

      const tick = await buildWorker(harness, runner).runOnce();
      expect(tick.status).toBe("COMPLETED");
      expect(runner.calls).toBe(1);

      const analysis = await harness.prisma.analysis.findUniqueOrThrow({
        where: { id: harness.analysisId },
        include: { job: true }
      });
      expect(analysis.status).toBe("COMPLETED");
      expect(analysis.job?.status).toBe("SUCCEEDED");
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("does not execute a job that was cancelled while it waited in the queue", async () => {
    const harness = await seedPendingAnalysis("cancel");
    const runner = new ScriptedRunner(["pass"]);

    try {
      await harness.prisma.analysisJob.updateMany({
        where: { analysisId: harness.analysisId },
        data: { cancelRequested: true }
      });
      const tick = await buildWorker(harness, runner).runOnce();

      expect(tick.status).toBe("CANCELLED");
      expect(runner.calls).toBe(0);
      const analysis = await harness.prisma.analysis.findUniqueOrThrow({
        where: { id: harness.analysisId },
        include: { job: true }
      });
      expect(analysis.status).toBe("CANCELLED");
      expect(analysis.job?.status).toBe("CANCELLED");
    } finally {
      await harness.close();
    }
  }, 60_000);
});
