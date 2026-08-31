import type { QualityEvidence } from "./index.js";

/**
 * Evidence that no adapter executes yet. It is supplied by configuration or intake,
 * never derived from a test run.
 */
export type SuppliedEvidence = Pick<
  QualityEvidence,
  | "mutationScore"
  | "coverage"
  | "mitigationCoverage"
  | "criticalSecurityIssues"
  | "survivedCriticalMutants"
>;

export interface ExecutedResult {
  status: string;
  critical: boolean;
  retries: number;
}

export interface ExecutedSuite {
  kind: string;
  results: ExecutedResult[];
}

const REGRESSION_KINDS = new Set(["SMOKE", "REGRESSION"]);
const FAILED_STATUSES = new Set(["FAILED", "TIMED_OUT"]);

interface Totals {
  passed: number;
  failed: number;
  criticalFailures: number;
  flaky: number;
  executed: number;
}

const emptyTotals = (): Totals => ({
  passed: 0,
  failed: 0,
  criticalFailures: 0,
  flaky: 0,
  executed: 0
});

const accumulate = (totals: Totals, result: ExecutedResult): void => {
  if (result.status === "SKIPPED") return;
  totals.executed += 1;
  if (FAILED_STATUSES.has(result.status)) {
    totals.failed += 1;
    if (result.critical) totals.criticalFailures += 1;
    return;
  }
  totals.passed += 1;
  if (result.status === "FLAKY" || result.retries > 0) totals.flaky += 1;
};

/**
 * Builds the evidence handed to the quality engine. Regression, API and flakiness
 * come only from what actually executed; coverage, mutation and security figures are
 * the values supplied at intake, because no adapter produces them yet.
 */
export const buildQualityEvidence = (
  executions: readonly ExecutedSuite[],
  supplied: SuppliedEvidence
): QualityEvidence => {
  const regression = emptyTotals();
  const api = emptyTotals();

  for (const execution of executions) {
    const target = execution.kind === "API" ? api : REGRESSION_KINDS.has(execution.kind) ? regression : null;
    if (!target) continue;
    for (const result of execution.results) accumulate(target, result);
  }

  const totalExecuted = regression.executed + api.executed;
  const totalFlaky = regression.flaky + api.flaky;

  const evidence: QualityEvidence = {};

  if (regression.executed > 0) {
    evidence.regression = {
      passed: regression.passed,
      failed: regression.failed,
      criticalFailures: regression.criticalFailures
    };
  }
  if (api.executed > 0) {
    evidence.api = { passed: api.passed, failed: api.failed };
  }
  if (totalExecuted > 0) {
    evidence.flakyRate = Number(((totalFlaky / totalExecuted) * 100).toFixed(2));
  }

  if (supplied.mutationScore !== undefined) evidence.mutationScore = supplied.mutationScore;
  if (supplied.coverage !== undefined) evidence.coverage = supplied.coverage;
  if (supplied.mitigationCoverage !== undefined) {
    evidence.mitigationCoverage = supplied.mitigationCoverage;
  }
  if (supplied.criticalSecurityIssues !== undefined) {
    evidence.criticalSecurityIssues = supplied.criticalSecurityIssues;
  }
  if (supplied.survivedCriticalMutants !== undefined) {
    evidence.survivedCriticalMutants = supplied.survivedCriticalMutants;
  }

  return evidence;
};
