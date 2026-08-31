import { createHash } from "node:crypto";
import type {
  CreateAnalysisRequest,
  CreateDeterministicAnalysisRequest
} from "@qualityguard/contracts";
import {
  AnalysisIdParamsSchema,
  CreateAnalysisRequestSchema,
  CreateDeterministicAnalysisRequestSchema
} from "@qualityguard/contracts";
import type { RepositoryAnalysis } from "@qualityguard/core";
import { analyzeGitDiff } from "@qualityguard/git-analyzer";
import {
  AnalysisRepository,
  JobQueue,
  WorkerAnalysisRepository,
  createPrismaClient,
  type QualityGuardPrismaClient
} from "@qualityguard/persistence-prisma";
import {
  calculateQualityScore,
  DEFAULT_QUALITY_POLICY,
  evaluateQualityGate
} from "@qualityguard/quality-engine";
import { assessRisk, DEFAULT_RISK_POLICY } from "@qualityguard/risk-engine";
import Fastify, { type FastifyInstance } from "fastify";

export interface BuildAppOptions {
  prisma?: QualityGuardPrismaClient;
  logger?: boolean;
}

const POLICY_VERSION = `${DEFAULT_RISK_POLICY.version}+${DEFAULT_QUALITY_POLICY.version}`;

const validateEvidenceConsistency = (request: CreateDeterministicAnalysisRequest): void => {
  const regression = request.qualityEvidence?.regression;
  if (regression && regression.criticalFailures > regression.failed) {
    throw new Error("criticalFailures cannot be greater than failed regression tests.");
  }
};

const buildIdempotencyKey = (
  parts: readonly string[],
  repositoryAnalysis: RepositoryAnalysis,
  mode: string
): string =>
  createHash("sha256")
    .update([...parts, repositoryAnalysis.diffHash, POLICY_VERSION, mode].join(":"), "utf8")
    .digest("hex");

export const buildApp = (options: BuildAppOptions = {}): FastifyInstance => {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 2_100_000,
    // Fastify strips unknown properties by default; an unexpected field is rejected
    // instead, so a caller never believes it supplied evidence that was dropped.
    ajv: { customOptions: { removeAdditional: false } }
  });
  const prisma = options.prisma ?? createPrismaClient();
  const analyses = new AnalysisRepository(prisma);
  const workerAnalyses = new WorkerAnalysisRepository(prisma);
  const jobs = new JobQueue(prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  app.get("/health", async () => ({ status: "ok", service: "qualityguard-api" }));

  /**
   * Asynchronous intake. The diff is parsed here because the raw diff is never stored;
   * only its hash and the normalized changes are persisted. Everything that requires
   * running a process happens in the worker.
   */
  app.post<{ Body: CreateAnalysisRequest }>(
    "/api/v1/analyses",
    { schema: { body: CreateAnalysisRequestSchema } },
    async (request, reply) => {
      try {
        const repositoryAnalysis = analyzeGitDiff(
          request.body.gitDiff,
          request.body.criticalityRules ?? []
        );
        const idempotencyKey = buildIdempotencyKey(
          [
            request.body.project.slug,
            request.body.repository.name,
            request.body.repository.headSha
          ],
          repositoryAnalysis,
          "async"
        );

        const created = await workerAnalyses.createPending({
          project: request.body.project,
          repository: {
            ...request.body.repository,
            provider: request.body.repository.provider ?? "LOCAL"
          },
          idempotencyKey,
          policyVersion: POLICY_VERSION,
          repositoryAnalysis,
          riskMetrics: request.body.riskMetrics ?? {},
          suppliedEvidence: request.body.suppliedEvidence ?? {}
        });

        return reply.code(202).send({
          id: created.analysisId,
          status: created.status,
          mode: "ASYNCHRONOUS",
          created: created.created,
          policyVersion: POLICY_VERSION,
          affectedAreas: repositoryAnalysis.affectedAreas,
          changedFiles: repositoryAnalysis.changes.length,
          changedLines: repositoryAnalysis.totalChangedLines
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown analysis error";
        request.log.warn({ errorCode: "ANALYSIS_REJECTED" }, message);
        return reply.code(422).send({ error: "ANALYSIS_REJECTED", message });
      }
    }
  );

  /**
   * Deterministic fixture mode: no process is executed and every result comes from the
   * evidence in the payload. Kept for reproducible policy checks, never for release
   * evidence produced by a real test run.
   */
  app.post<{ Body: CreateDeterministicAnalysisRequest }>(
    "/api/v1/analyses/deterministic",
    { schema: { body: CreateDeterministicAnalysisRequestSchema } },
    async (request, reply) => {
      try {
        validateEvidenceConsistency(request.body);
        const repositoryAnalysis = analyzeGitDiff(
          request.body.gitDiff,
          request.body.criticalityRules ?? []
        );
        const inferredBusinessCriticality = Math.max(
          ...repositoryAnalysis.changes.map((change) => change.businessCriticality)
        );
        const risk = assessRisk({
          changedFiles: repositoryAnalysis.changes.length,
          changedLines: repositoryAnalysis.totalChangedLines,
          inferredBusinessCriticality,
          metrics: request.body.riskMetrics
        });
        const evidence = request.body.qualityEvidence ?? {};
        const quality = calculateQualityScore(risk, evidence);
        const gate = evaluateQualityGate(risk, quality, evidence);
        const idempotencyKey = buildIdempotencyKey(
          [
            request.body.project.slug,
            request.body.repository.name,
            request.body.repository.headSha
          ],
          repositoryAnalysis,
          "deterministic"
        );

        const analysis = await analyses.persistCompleted({
          project: request.body.project,
          repository: {
            ...request.body.repository,
            provider: request.body.repository.provider ?? "LOCAL"
          },
          idempotencyKey,
          policyVersion: POLICY_VERSION,
          repositoryAnalysis,
          risk,
          quality,
          gate
        });

        return reply.code(201).send(analysis);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown analysis error";
        request.log.warn({ errorCode: "ANALYSIS_REJECTED" }, message);
        return reply.code(422).send({ error: "ANALYSIS_REJECTED", message });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/analyses/:id",
    { schema: { params: AnalysisIdParamsSchema } },
    async (request, reply) => {
      const analysis = await analyses.getById(request.params.id);
      if (!analysis) {
        return reply.code(404).send({ error: "ANALYSIS_NOT_FOUND" });
      }
      return reply.send(analysis);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/analyses/:id/cancel",
    { schema: { params: AnalysisIdParamsSchema } },
    async (request, reply) => {
      const analysis = await analyses.getById(request.params.id);
      if (!analysis) {
        return reply.code(404).send({ error: "ANALYSIS_NOT_FOUND" });
      }

      const outcome = await jobs.requestCancellation(request.params.id);
      if (!outcome.accepted) {
        return reply.code(409).send({
          error: "CANCELLATION_NOT_POSSIBLE",
          message:
            outcome.status === null
              ? "This analysis has no queued job; deterministic analyses cannot be cancelled."
              : `The job is already in status ${outcome.status}.`
        });
      }

      if (outcome.status === "CANCELLED") {
        await workerAnalyses.setStatus(request.params.id, "CANCELLED");
      }

      return reply.send({
        id: request.params.id,
        cancellationRequested: true,
        jobStatus: outcome.status
      });
    }
  );

  return app;
};
