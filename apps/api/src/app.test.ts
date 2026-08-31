import { createPrismaClient } from "@evidence-gate/persistence-prisma";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/helpers/database.js";
import { buildApp } from "./app.js";

const databases: TestDatabase[] = [];

const newDatabase = (): TestDatabase => {
  const database = createTestDatabase("api-integration-tests");
  databases.push(database);
  return database;
};

afterEach(() => {
  for (const database of databases.splice(0)) database.remove();
});

const gitDiff = `diff --git a/src/payment/limit.ts b/src/payment/limit.ts
index 1111111..2222222 100644
--- a/src/payment/limit.ts
+++ b/src/payment/limit.ts
@@ -1 +1 @@
-export const limit = 10;
+export const limit = 20;
`;

const project = { name: "Evidence Gate Demo", slug: "evidence-gate-demo" } as const;
const repository = {
  name: "checkout-service",
  provider: "LOCAL",
  branch: "feature/payment-limit",
  baseSha: "1111111",
  headSha: "2222222"
} as const;
const criticalityRules = [
  { pathPrefix: "src/payment/", area: "Payments", businessCriticality: 90 }
] as const;
const riskMetrics = {
  bugCount: 0,
  coverage: 95,
  mutationScore: 90,
  previousFailureRate: 0,
  changesLast90Days: 1,
  relatedTests: 5
} as const;

describe("deterministic analysis endpoint", () => {
  it("persists an explainable analysis and handles repeated input idempotently", async () => {
    const database = newDatabase();
    const app = buildApp({ prisma: createPrismaClient(database.url), logger: false });
    const payload = {
      project,
      repository,
      gitDiff,
      criticalityRules,
      riskMetrics,
      qualityEvidence: {
        regression: { passed: 100, failed: 0, criticalFailures: 0 },
        mutationScore: 90,
        api: { passed: 20, failed: 0 },
        flakyRate: 0,
        coverage: 95,
        mitigationCoverage: 100,
        criticalSecurityIssues: 0,
        survivedCriticalMutants: 0
      }
    } as const;

    try {
      const firstResponse = await app.inject({
        method: "POST",
        url: "/api/v1/analyses/deterministic",
        payload
      });
      expect(firstResponse.statusCode).toBe(201);
      const firstAnalysis = firstResponse.json<{
        id: string;
        status: string;
        riskAssessment: { score: number; level: string };
        qualityScore: { score: number };
        qualityGate: { decision: string };
        changes: { area: string }[];
      }>();
      expect(firstAnalysis.status).toBe("COMPLETED");
      expect(firstAnalysis.riskAssessment.score).toBeGreaterThan(0);
      expect(firstAnalysis.qualityScore.score).toBeGreaterThanOrEqual(85);
      expect(firstAnalysis.qualityGate.decision).toBe("RELEASE_APPROVED");
      expect(firstAnalysis.changes[0]?.area).toBe("Payments");

      const repeatedResponse = await app.inject({
        method: "POST",
        url: "/api/v1/analyses/deterministic",
        payload
      });
      expect(repeatedResponse.statusCode).toBe(201);
      expect(repeatedResponse.json<{ id: string }>().id).toBe(firstAnalysis.id);

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/v1/analyses/${firstAnalysis.id}`
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json<{ id: string }>().id).toBe(firstAnalysis.id);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("asynchronous analysis endpoint", () => {
  it("queues the analysis without executing anything on the HTTP thread", async () => {
    const database = newDatabase();
    const app = buildApp({ prisma: createPrismaClient(database.url), logger: false });
    const payload = {
      project,
      repository,
      gitDiff,
      criticalityRules,
      riskMetrics,
      suppliedEvidence: { coverage: 95, mutationScore: 90, criticalSecurityIssues: 0 }
    } as const;

    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/analyses", payload });
      expect(response.statusCode).toBe(202);
      const accepted = response.json<{
        id: string;
        status: string;
        mode: string;
        created: boolean;
        affectedAreas: string[];
      }>();
      expect(accepted.status).toBe("PENDING");
      expect(accepted.mode).toBe("ASYNCHRONOUS");
      expect(accepted.created).toBe(true);
      expect(accepted.affectedAreas).toContain("Payments");

      const repeated = await app.inject({ method: "POST", url: "/api/v1/analyses", payload });
      expect(repeated.statusCode).toBe(202);
      const repeatedBody = repeated.json<{ id: string; created: boolean }>();
      expect(repeatedBody.id).toBe(accepted.id);
      expect(repeatedBody.created).toBe(false);

      const stored = await app.inject({ method: "GET", url: `/api/v1/analyses/${accepted.id}` });
      const analysis = stored.json<{
        status: string;
        job: { status: string } | null;
        qualityGate: unknown;
        executions: unknown[];
      }>();
      expect(analysis.status).toBe("PENDING");
      expect(analysis.job?.status).toBe("QUEUED");
      expect(analysis.qualityGate).toBeNull();
      expect(analysis.executions).toHaveLength(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects a payload that tries to supply regression evidence", async () => {
    const database = newDatabase();
    const app = buildApp({ prisma: createPrismaClient(database.url), logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/analyses",
        payload: {
          project,
          repository,
          gitDiff,
          suppliedEvidence: { regression: { passed: 10, failed: 0, criticalFailures: 0 } }
        }
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("cancels a queued analysis", async () => {
    const database = newDatabase();
    const app = buildApp({ prisma: createPrismaClient(database.url), logger: false });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/analyses",
        payload: { project, repository, gitDiff }
      });
      const analysisId = created.json<{ id: string }>().id;

      const cancelled = await app.inject({
        method: "POST",
        url: `/api/v1/analyses/${analysisId}/cancel`
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json<{ jobStatus: string }>().jobStatus).toBe("CANCELLED");

      const stored = await app.inject({ method: "GET", url: `/api/v1/analyses/${analysisId}` });
      expect(stored.json<{ status: string }>().status).toBe("CANCELLED");

      const again = await app.inject({
        method: "POST",
        url: `/api/v1/analyses/${analysisId}/cancel`
      });
      expect(again.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  }, 30_000);
});
