import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type {
  GitChange,
  QualityGateResult,
  QualityScoreResult,
  RepositoryAnalysis,
  RiskAssessment
} from "@evidence-gate/core";
import { PrismaClient } from "./generated/prisma/client";
import { toJson } from "./json.js";

export * from "./job-queue.js";
export * from "./json.js";
export * from "./worker-repository.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = resolve(packageRoot, "../../../data/evidence-gate.db").replaceAll("\\", "/");

export const resolveDatabaseUrl = (): string =>
  process.env.DATABASE_URL ?? `file:${defaultDatabasePath}`;

export const createPrismaClient = (url = resolveDatabaseUrl()): PrismaClient => {
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
};

export interface PersistAnalysisInput {
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
  risk: RiskAssessment;
  quality: QualityScoreResult;
  gate: QualityGateResult;
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

const analysisInclude = {
  repository: { include: { project: true } },
  stages: true,
  changes: true,
  riskAssessment: true,
  qualityScore: true,
  qualityGate: true,
  job: true,
  testSelection: true,
  executions: { include: { suites: { include: { results: true } }, artifacts: true } }
} as const;

export class AnalysisRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async persistCompleted(input: PersistAnalysisInput) {
    const existing = await this.prisma.analysis.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: analysisInclude
    });
    if (existing) return existing;

    return this.prisma.$transaction(async (transaction) => {
      const project = await transaction.project.upsert({
        where: { slug: input.project.slug },
        update: { name: input.project.name },
        create: input.project
      });
      const repository = await transaction.repository.upsert({
        where: {
          projectId_name: { projectId: project.id, name: input.repository.name }
        },
        update: {
          provider: input.repository.provider,
          defaultBranch: input.repository.branch
        },
        create: {
          projectId: project.id,
          provider: input.repository.provider,
          name: input.repository.name,
          defaultBranch: input.repository.branch
        }
      });

      return transaction.analysis.create({
        data: {
          repositoryId: repository.id,
          branch: input.repository.branch,
          baseSha: input.repository.baseSha,
          headSha: input.repository.headSha,
          idempotencyKey: input.idempotencyKey,
          status: "COMPLETED",
          diffHash: input.repositoryAnalysis.diffHash,
          affectedAreas: toJson(input.repositoryAnalysis.affectedAreas),
          policyVersion: input.policyVersion,
          completedAt: new Date(),
          stages: {
            create: [
              { name: "REPOSITORY_ANALYSIS", status: "COMPLETED", attempts: 1 },
              { name: "RISK_ASSESSMENT", status: "COMPLETED", attempts: 1 },
              { name: "QUALITY_CALCULATION", status: "COMPLETED", attempts: 1 },
              { name: "QUALITY_GATE", status: "COMPLETED", attempts: 1 }
            ]
          },
          changes: { create: input.repositoryAnalysis.changes.map(mapChange) },
          riskAssessment: {
            create: {
              score: input.risk.score,
              level: input.risk.level,
              confidence: input.risk.confidence,
              factors: toJson(input.risk.factors),
              missingEvidence: toJson(input.risk.missingEvidence)
            }
          },
          qualityScore: {
            create: {
              score: input.quality.score,
              confidence: input.quality.confidence,
              components: toJson(input.quality.components),
              missingEvidence: toJson(input.quality.missingEvidence)
            }
          },
          qualityGate: {
            create: {
              decision: input.gate.decision,
              reasons: toJson(input.gate.reasons),
              evaluatedRules: toJson(input.gate.evaluatedRules)
            }
          }
        },
        include: analysisInclude
      });
    });
  }

  public getById(id: string) {
    return this.prisma.analysis.findUnique({ where: { id }, include: analysisInclude });
  }
}

export type EvidenceGatePrismaClient = PrismaClient;
