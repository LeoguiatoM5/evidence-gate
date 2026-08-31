import type { TestExecutionReport, TestSelection, TestSuiteKind } from "@qualityguard/core";
import type { QualityEvidence, SuppliedEvidence } from "@qualityguard/quality-engine";
import { buildQualityEvidence, selectTests } from "@qualityguard/quality-engine";
import type { RiskLevel } from "@qualityguard/core";

/** Thin adapters so the CLI feeds the shared domain policy the same shapes the worker does. */

export const selectSuites = (
  riskLevel: RiskLevel,
  available: readonly { key: string; kind: TestSuiteKind }[]
): TestSelection => selectTests(riskLevel, available);

export const buildEvidence = (
  executions: readonly TestExecutionReport[],
  supplied: SuppliedEvidence
): QualityEvidence =>
  buildQualityEvidence(
    executions.map((execution) => ({
      kind: execution.kind,
      results: execution.suites.flatMap((suite) =>
        suite.results.map((result) => ({
          status: result.status,
          critical: result.critical,
          retries: result.retries
        }))
      )
    })),
    supplied
  );
