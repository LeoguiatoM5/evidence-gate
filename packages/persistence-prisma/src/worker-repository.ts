import type {
  AnalysisStatus,
  GitChange,
  QualityGateResult,
  QualityScoreResult,
  RepositoryAnalysis,
  RiskAssessment,
  TestExecutionReport,
  TestSelection,
  WorkerStage
} from "@evidence-gate/core";
import type { PrismaClient } from "./generated/prisma/client";
import { toJson } from "./json.js";

export interface SuppliedEvidence {
  mutationScore?: number;
  coverage?: number;
  mitigationCoverage?: number;
  criticalSecurityIssues?: number;
  survivedCriticalMutants?: number;
}

export interface RiskMetricsInput {
  businessCriticality?: number;
  bugCount?: number;
  coverage?: number;
  mutationScore?: number;
  previousFailureRate?: number;
  changesLast90Days?: number;
  relatedTests?: number;
}

export interface CreatePendingAnalysisInput {
  project: { name: string; slug: string };
  repository: {
    name: string;
    provider: "LOCAL" | "GITHUB";
    branch: string;
    baseSha?: string;
    headSha: string;
  };
  idempotencyKey: string;
  policyVersion: string;
  repositoryAnalysis: RepositoryAnalysis;
  riskMetrics: RiskMetricsInput;
  suppliedEvidence: SuppliedEvidence;
  maxAttempts?: number;
}

export interface WorkerAnalysisContext {
  analysisId: string;
  status: AnalysisStatus;
  diffHash: string;
  policyVersion: string;
  changes: GitChange[];
  affectedAreas: string[];
  totalAdditions: number;
  totalDeletions: number;
  totalChangedLines: number;
  riskMetrics: RiskMetricsInput;
  suppliedEvidence: SuppliedEvidence;
}

const mapChange = (change: GitChange) => ({
  path: change.path,
  oldPath: change.oldPath,
  type: change.type,
  additions: change.additions,
  deletions: change.deletions,
  extension: change.extension,
  area: change.area,
  businessCriticality: change.businessCriticality
});

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const asRecord = <T>(value: unknown): T =>
  (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as T;

/** Persistence used by the asynchronous pipeline. Every write is idempotent so a
 * resumed job never duplicates rows. */
export class WorkerAnalysisRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates the analysis in PENDING together with its queue row. The raw diff is not
   * stored: only the hash and the normalized changes produced at intake.
   */
  public async createPending(input: CreatePendingAnalysisInput): Promise<{
    analysisId: string;
    created: boolean;
    status: AnalysisStatus;
  }> {
    const existing = await this.prisma.analysis.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true }
    });
    if (existing) {
      return { analysisId: existing.id, created: false, status: existing.status as AnalysisStatus };
    }

    const analysisId = await this.prisma.$transaction(async (transaction) => {
      const project = await transaction.project.upsert({
        where: { slug: input.project.slug },
        update: { name: input.project.name },
        create: input.project
      });
      const repository = await transaction.repository.upsert({
        where: { projectId_name: { projectId: project.id, name: input.repository.name } },
        update: { provider: input.repository.provider, defaultBranch: input.repository.branch },
        create: {
          projectId: project.id,
          provider: input.repository.provider,
          name: input.repository.name,
          defaultBranch: input.repository.branch
        }
      });

      const analysis = await transaction.analysis.create({
        data: {
          repositoryId: repository.id,
          branch: input.repository.branch,
          baseSha: input.repository.baseSha,
          headSha: input.repository.headSha,
          idempotencyKey: input.idempotencyKey,
          status: "PENDING",
          diffHash: input.repositoryAnalysis.diffHash,
          affectedAreas: toJson(input.repositoryAnalysis.affectedAreas),
          policyVersion: input.policyVersion,
          changes: { create: input.repositoryAnalysis.changes.map(mapChange) },
          input: {
            create: {
              riskMetrics: toJson(input.riskMetrics),
              suppliedEvidence: toJson(input.suppliedEvidence)
            }
          },
          job: { create: { status: "QUEUED", maxAttempts: input.maxAttempts ?? 3 } }
        },
        select: { id: true }
      });

      return analysis.id;
    });

    return { analysisId, created: true, status: "PENDING" };
  }

  public async loadContext(analysisId: string): Promise<WorkerAnalysisContext | null> {
    const analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { changes: true, input: true }
    });
    if (!analysis) return null;

    const changes: GitChange[] = analysis.changes.map((change) => ({
      path: change.path,
      oldPath: change.oldPath,
      type: change.type as GitChange["type"],
      additions: change.additions,
      deletions: change.deletions,
      extension: change.extension,
      area: change.area,
      businessCriticality: change.businessCriticality
    }));

    return {
      analysisId: analysis.id,
      status: analysis.status as AnalysisStatus,
      diffHash: analysis.diffHash,
      policyVersion: analysis.policyVersion,
      changes,
      affectedAreas: asStringArray(analysis.affectedAreas),
      totalAdditions: changes.reduce((total, change) => total + change.additions, 0),
      totalDeletions: changes.reduce((total, change) => total + change.deletions, 0),
      totalChangedLines: changes.reduce(
        (total, change) => total + change.additions + change.deletions,
        0
      ),
      riskMetrics: asRecord<RiskMetricsInput>(analysis.input?.riskMetrics),
      suppliedEvidence: asRecord<SuppliedEvidence>(analysis.input?.suppliedEvidence)
    };
  }

  public async loadRiskAssessment(analysisId: string): Promise<RiskAssessment | null> {
    const record = await this.prisma.riskAssessment.findUnique({ where: { analysisId } });
    if (!record) return null;
    return {
      score: record.score,
      level: record.level as RiskAssessment["level"],
      confidence: record.confidence,
      factors: (Array.isArray(record.factors)
        ? record.factors
        : []) as unknown as RiskAssessment["factors"],
      missingEvidence: (Array.isArray(record.missingEvidence)
        ? record.missingEvidence
        : []) as unknown as RiskAssessment["missingEvidence"]
    };
  }

  public async loadTestSelection(analysisId: string): Promise<TestSelection | null> {
    const record = await this.prisma.testSelection.findUnique({ where: { analysisId } });
    if (!record) return null;
    return {
      strategy: record.strategy as TestSelection["strategy"],
      suiteKeys: asStringArray(record.suiteKeys),
      reason: record.reason
    };
  }

  public async setStatus(analysisId: string, status: AnalysisStatus): Promise<void> {
    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: {
        status,
        completedAt: status === "COMPLETED" ? new Date() : undefined
      }
    });
  }

  public async isStageCompleted(analysisId: string, stage: WorkerStage): Promise<boolean> {
    const record = await this.prisma.analysisStage.findUnique({
      where: { analysisId_name: { analysisId, name: stage } },
      select: { status: true }
    });
    return record?.status === "COMPLETED";
  }

  public async beginStage(analysisId: string, stage: WorkerStage): Promise<void> {
    await this.prisma.analysisStage.upsert({
      where: { analysisId_name: { analysisId, name: stage } },
      update: {
        status: "RUNNING",
        attempts: { increment: 1 },
        startedAt: new Date(),
        completedAt: null,
        errorCode: null
      },
      create: { analysisId, name: stage, status: "RUNNING", attempts: 1, startedAt: new Date() }
    });
  }

  public async completeStage(analysisId: string, stage: WorkerStage): Promise<void> {
    await this.prisma.analysisStage.update({
      where: { analysisId_name: { analysisId, name: stage } },
      data: { status: "COMPLETED", completedAt: new Date(), errorCode: null }
    });
  }

  public async failStage(
    analysisId: string,
    stage: WorkerStage,
    errorCode: string
  ): Promise<void> {
    await this.prisma.analysisStage.upsert({
      where: { analysisId_name: { analysisId, name: stage } },
      update: { status: "FAILED", completedAt: new Date(), errorCode },
      create: {
        analysisId,
        name: stage,
        status: "FAILED",
        attempts: 1,
        startedAt: new Date(),
        completedAt: new Date(),
        errorCode
      }
    });
  }

  public async saveRiskAssessment(analysisId: string, risk: RiskAssessment): Promise<void> {
    const data = {
      score: risk.score,
      level: risk.level,
      confidence: risk.confidence,
      factors: toJson(risk.factors),
      missingEvidence: toJson(risk.missingEvidence)
    };
    await this.prisma.riskAssessment.upsert({
      where: { analysisId },
      update: data,
      create: { analysisId, ...data }
    });
  }

  public async saveTestSelection(
    analysisId: string,
    riskLevel: string,
    selection: TestSelection
  ): Promise<void> {
    const data = {
      strategy: selection.strategy,
      riskLevel,
      suiteKeys: toJson(selection.suiteKeys),
      reason: selection.reason
    };
    await this.prisma.testSelection.upsert({
      where: { analysisId },
      update: data,
      create: { analysisId, ...data }
    });
  }

  /** Replaces any previous execution of the same suite so a retry never duplicates results. */
  public async saveExecution(analysisId: string, report: TestExecutionReport): Promise<string> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.testExecution.deleteMany({
        where: { analysisId, suiteKey: report.suiteKey }
      });

      const execution = await transaction.testExecution.create({
        data: {
          analysisId,
          suiteKey: report.suiteKey,
          kind: report.kind,
          runner: report.runner,
          status: report.status,
          exitCode: report.exitCode,
          durationMs: report.durationMs,
          timedOut: report.timedOut,
          outputTruncated: report.outputTruncated,
          errorMessage: report.errorMessage,
          completedAt: new Date(),
          artifacts: {
            create: report.artifacts.map((artifact) => ({
              type: artifact.type,
              path: artifact.path,
              sizeBytes: artifact.sizeBytes,
              contentType: artifact.contentType
            }))
          }
        },
        select: { id: true }
      });

      for (const suite of report.suites) {
        await transaction.testSuite.create({
          data: {
            executionId: execution.id,
            title: suite.title,
            file: suite.file,
            durationMs: suite.durationMs,
            results: {
              create: suite.results.map((result) => ({
                identity: result.identity,
                title: result.title,
                status: result.status,
                durationMs: result.durationMs,
                retries: result.retries,
                critical: result.critical,
                errorType: result.errorType,
                errorMessage: result.errorMessage
              }))
            }
          }
        });
      }

      return execution.id;
    });
  }

  public async loadExecutionReports(analysisId: string): Promise<
    {
      suiteKey: string;
      kind: string;
      status: string;
      timedOut: boolean;
      results: {
        status: string;
        critical: boolean;
        retries: number;
      }[];
    }[]
  > {
    const executions = await this.prisma.testExecution.findMany({
      where: { analysisId },
      include: { suites: { include: { results: true } } },
      orderBy: { suiteKey: "asc" }
    });

    return executions.map((execution) => ({
      suiteKey: execution.suiteKey,
      kind: execution.kind,
      status: execution.status,
      timedOut: execution.timedOut,
      results: execution.suites.flatMap((suite) =>
        suite.results.map((result) => ({
          status: result.status,
          critical: result.critical,
          retries: result.retries
        }))
      )
    }));
  }

  public async saveQuality(
    analysisId: string,
    quality: QualityScoreResult,
    gate: QualityGateResult
  ): Promise<void> {
    const scoreData = {
      score: quality.score,
      confidence: quality.confidence,
      components: toJson(quality.components),
      missingEvidence: toJson(quality.missingEvidence)
    };
    const gateData = {
      decision: gate.decision,
      reasons: toJson(gate.reasons),
      evaluatedRules: toJson(gate.evaluatedRules)
    };

    await this.prisma.$transaction([
      this.prisma.qualityScore.upsert({
        where: { analysisId },
        update: scoreData,
        create: { analysisId, ...scoreData }
      }),
      this.prisma.qualityGate.upsert({
        where: { analysisId },
        update: gateData,
        create: { analysisId, ...gateData }
      })
    ]);
  }
}
