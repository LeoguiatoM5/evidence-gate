import type {
  GateReason,
  QualityComponent,
  QualityComponentKey,
  QualityGateResult,
  QualityScoreResult,
  RiskAssessment
} from "@evidence-gate/core";

export interface TestSummary {
  passed: number;
  failed: number;
}

export interface RegressionSummary extends TestSummary {
  criticalFailures: number;
}

export interface QualityEvidence {
  regression?: RegressionSummary;
  mutationScore?: number;
  api?: TestSummary;
  flakyRate?: number;
  coverage?: number;
  mitigationCoverage?: number;
  criticalSecurityIssues?: number;
  survivedCriticalMutants?: number;
}

export interface QualityPolicy {
  version: string;
  weights: Record<QualityComponentKey, number>;
  approvedMinimum: number;
  reviewMinimum: number;
  mutationMinimum: number;
  maximumFlakyRate: number;
  minimumConfidence: number;
}

export const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  version: "quality-v1",
  weights: {
    regression: 25,
    mutation: 20,
    riskControl: 20,
    api: 10,
    testStability: 10,
    coverage: 10,
    evidenceCompleteness: 5
  },
  approvedMinimum: 85,
  reviewMinimum: 65,
  mutationMinimum: 75,
  maximumFlakyRate: 10,
  minimumConfidence: 80
};

const clamp = (value: number): number => Math.min(100, Math.max(0, value));
const passRate = (summary: TestSummary | undefined): number | undefined => {
  if (!summary) return undefined;
  const executed = summary.passed + summary.failed;
  return executed === 0 ? undefined : (summary.passed / executed) * 100;
};

const validatePolicy = (policy: QualityPolicy): void => {
  const total = Object.values(policy.weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 100) > Number.EPSILON) {
    throw new Error(`Quality weights must total 100; received ${total}.`);
  }
  if (policy.reviewMinimum >= policy.approvedMinimum) {
    throw new Error("Quality review threshold must be lower than the approval threshold.");
  }
};

export const calculateQualityScore = (
  risk: RiskAssessment,
  evidence: QualityEvidence,
  policy: QualityPolicy = DEFAULT_QUALITY_POLICY
): QualityScoreResult => {
  validatePolicy(policy);

  const regressionScore = passRate(evidence.regression);
  const apiScore = passRate(evidence.api);
  const mutationScore = evidence.mutationScore;
  const stabilityScore =
    evidence.flakyRate === undefined
      ? undefined
      : 100 - clamp((evidence.flakyRate / policy.maximumFlakyRate) * 100);
  const coverageScore = evidence.coverage;
  const riskControlScore =
    evidence.mitigationCoverage === undefined
      ? undefined
      : 100 - risk.score * (1 - clamp(evidence.mitigationCoverage) / 100);

  const rawComponents: Array<{
    key: Exclude<QualityComponentKey, "evidenceCompleteness">;
    score: number | undefined;
    reason: string;
  }> = [
    { key: "regression", score: regressionScore, reason: "Regression pass rate" },
    { key: "mutation", score: mutationScore, reason: "Mutation score" },
    { key: "riskControl", score: riskControlScore, reason: "Residual risk after mitigation" },
    { key: "api", score: apiScore, reason: "API test pass rate" },
    { key: "testStability", score: stabilityScore, reason: "Penalty derived from flaky rate" },
    { key: "coverage", score: coverageScore, reason: "Reported code coverage" }
  ];

  const evidenceWeight = rawComponents
    .filter((component) => component.score !== undefined)
    .reduce((sum, component) => sum + policy.weights[component.key], 0);
  const possibleEvidenceWeight = rawComponents.reduce(
    (sum, component) => sum + policy.weights[component.key],
    0
  );
  const evidenceCompleteness = (evidenceWeight / possibleEvidenceWeight) * 100;

  const components: QualityComponent[] = [
    ...rawComponents.map((component) => {
      const available = component.score !== undefined;
      const score = clamp(component.score ?? 0);
      const weight = policy.weights[component.key];
      return {
        key: component.key,
        score: Math.round(score * 100) / 100,
        weight,
        contribution: Math.round(score * weight) / 100,
        available,
        reason: available ? component.reason : `INSUFFICIENT EVIDENCE: ${component.reason}`
      };
    }),
    {
      key: "evidenceCompleteness",
      score: Math.round(evidenceCompleteness * 100) / 100,
      weight: policy.weights.evidenceCompleteness,
      contribution: Math.round(evidenceCompleteness * policy.weights.evidenceCompleteness) / 100,
      available: true,
      reason: "Availability of required quality evidence"
    }
  ];

  const score = Math.round(
    clamp(components.reduce((sum, component) => sum + component.contribution, 0))
  );

  return {
    score,
    confidence: Math.round(evidenceCompleteness),
    components,
    missingEvidence: components
      .filter((component) => !component.available)
      .map((component) => component.key)
  };
};

export const evaluateQualityGate = (
  risk: RiskAssessment,
  quality: QualityScoreResult,
  evidence: QualityEvidence,
  policy: QualityPolicy = DEFAULT_QUALITY_POLICY
): QualityGateResult => {
  const reasons: GateReason[] = [];
  const evaluatedRules = [
    "CRITICAL_TEST_FAILURE",
    "CRITICAL_SECURITY_ISSUE",
    "MUTATION_THRESHOLD",
    "UNMITIGATED_CRITICAL_RISK",
    "QUALITY_SCORE",
    "EVIDENCE_CONFIDENCE",
    "CRITICAL_SURVIVED_MUTANT"
  ];

  if ((evidence.regression?.criticalFailures ?? 0) > 0) {
    reasons.push({
      code: "CRITICAL_TEST_FAILURE",
      message: "At least one critical test failed.",
      severity: "CRITICAL",
      actual: evidence.regression?.criticalFailures,
      expected: 0
    });
  }
  if ((evidence.criticalSecurityIssues ?? 0) > 0) {
    reasons.push({
      code: "CRITICAL_SECURITY_ISSUE",
      message: "A confirmed critical security issue is present.",
      severity: "CRITICAL",
      actual: evidence.criticalSecurityIssues,
      expected: 0
    });
  }
  if (evidence.mutationScore !== undefined && evidence.mutationScore < policy.mutationMinimum) {
    reasons.push({
      code: "MUTATION_BELOW_THRESHOLD",
      message: "Mutation score is below the configured minimum.",
      severity: "CRITICAL",
      actual: evidence.mutationScore,
      expected: `>= ${policy.mutationMinimum}`
    });
  }
  if (risk.level === "CRITICAL" && (evidence.mitigationCoverage ?? 0) < 100) {
    reasons.push({
      code: "UNMITIGATED_CRITICAL_RISK",
      message: "Critical risk has not been fully mitigated by the required validation plan.",
      severity: "CRITICAL",
      actual: evidence.mitigationCoverage ?? "INSUFFICIENT EVIDENCE",
      expected: 100
    });
  }
  if ((evidence.survivedCriticalMutants ?? 0) > 0) {
    reasons.push({
      code: "CRITICAL_SURVIVED_MUTANT",
      message: "Survived mutants exist in a critical area.",
      severity: "WARNING",
      actual: evidence.survivedCriticalMutants,
      expected: 0
    });
  }
  if (quality.missingEvidence.length > 0) {
    reasons.push({
      code: "INSUFFICIENT_EVIDENCE",
      message: `Missing quality evidence: ${quality.missingEvidence.join(", ")}.`,
      severity: "WARNING"
    });
  }
  if (quality.confidence < policy.minimumConfidence) {
    reasons.push({
      code: "LOW_EVIDENCE_CONFIDENCE",
      message: "Quality evidence confidence is below the configured minimum.",
      severity: "WARNING",
      actual: quality.confidence,
      expected: `>= ${policy.minimumConfidence}`
    });
  }

  const hasCriticalBlocker = reasons.some((reason) => reason.severity === "CRITICAL");
  if (hasCriticalBlocker || quality.score < policy.reviewMinimum) {
    if (quality.score < policy.reviewMinimum) {
      reasons.push({
        code: "QUALITY_SCORE_BLOCKED",
        message: "Quality Score is below the review threshold.",
        severity: "CRITICAL",
        actual: quality.score,
        expected: `>= ${policy.reviewMinimum}`
      });
    }
    return { decision: "RELEASE_BLOCKED", reasons, evaluatedRules };
  }

  const requiresReview =
    quality.score < policy.approvedMinimum ||
    quality.confidence < policy.minimumConfidence ||
    quality.missingEvidence.length > 0 ||
    reasons.some((reason) => reason.severity === "WARNING");

  if (requiresReview) {
    reasons.push({
      code: "MANUAL_REVIEW_REQUIRED",
      message: "The release does not satisfy every automatic approval condition.",
      severity: "WARNING",
      actual: quality.score,
      expected: `>= ${policy.approvedMinimum}`
    });
    return { decision: "REVIEW_REQUIRED", reasons, evaluatedRules };
  }

  reasons.push({
    code: "ALL_APPROVAL_RULES_SATISFIED",
    message: "All configured automatic approval conditions were satisfied.",
    severity: "INFO",
    actual: quality.score,
    expected: `>= ${policy.approvedMinimum}`
  });
  return { decision: "RELEASE_APPROVED", reasons, evaluatedRules };
};

export * from "./evidence.js";
export * from "./selection.js";
