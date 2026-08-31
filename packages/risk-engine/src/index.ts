import type {
  RiskAssessment,
  RiskFactorContribution,
  RiskFactorKey,
  RiskLevel
} from "@evidence-gate/core";

export interface RiskMetrics {
  businessCriticality?: number;
  bugCount?: number;
  coverage?: number;
  mutationScore?: number;
  previousFailureRate?: number;
  changesLast90Days?: number;
  relatedTests?: number;
}

export interface RiskInput {
  changedFiles: number;
  changedLines: number;
  inferredBusinessCriticality: number;
  metrics?: RiskMetrics;
}

export interface RiskPolicy {
  version: string;
  weights: Record<RiskFactorKey, number>;
  fallbacks: Record<RiskFactorKey, number>;
  normalization: {
    changedFilesForMaximum: number;
    changedLinesForMaximum: number;
    bugsForMaximum: number;
    changesForMaximum: number;
    expectedRelatedTests: number;
  };
  levels: {
    medium: number;
    high: number;
    critical: number;
  };
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  version: "risk-v1",
  weights: {
    businessCriticality: 25,
    changeSize: 15,
    bugHistory: 13,
    coverageGap: 12,
    mutationGap: 12,
    previousFailures: 10,
    changeFrequency: 8,
    relatedTestGap: 5
  },
  fallbacks: {
    businessCriticality: 50,
    changeSize: 0,
    bugHistory: 50,
    coverageGap: 60,
    mutationGap: 70,
    previousFailures: 50,
    changeFrequency: 50,
    relatedTestGap: 60
  },
  normalization: {
    changedFilesForMaximum: 20,
    changedLinesForMaximum: 500,
    bugsForMaximum: 10,
    changesForMaximum: 20,
    expectedRelatedTests: 5
  },
  levels: {
    medium: 30,
    high: 60,
    critical: 80
  }
};

const clamp = (value: number): number => Math.min(100, Math.max(0, value));
const ratioScore = (value: number, maximum: number): number => clamp((value / maximum) * 100);

const classifyRisk = (score: number, policy: RiskPolicy): RiskLevel => {
  if (score >= policy.levels.critical) return "CRITICAL";
  if (score >= policy.levels.high) return "HIGH";
  if (score >= policy.levels.medium) return "MEDIUM";
  return "LOW";
};

const validatePolicy = (policy: RiskPolicy): void => {
  const weightTotal = Object.values(policy.weights).reduce((total, weight) => total + weight, 0);
  if (Math.abs(weightTotal - 100) > Number.EPSILON) {
    throw new Error(`Risk weights must total 100; received ${weightTotal}.`);
  }
  if (!(policy.levels.medium < policy.levels.high && policy.levels.high < policy.levels.critical)) {
    throw new Error("Risk thresholds must be strictly increasing.");
  }
};

export const assessRisk = (
  input: RiskInput,
  policy: RiskPolicy = DEFAULT_RISK_POLICY
): RiskAssessment => {
  validatePolicy(policy);
  const metrics = input.metrics ?? {};
  const changeSize = clamp(
    ratioScore(input.changedLines, policy.normalization.changedLinesForMaximum) * 0.7 +
      ratioScore(input.changedFiles, policy.normalization.changedFilesForMaximum) * 0.3
  );

  const values: Record<RiskFactorKey, { value: number | undefined; fallbackIsEvidence?: boolean }> = {
    businessCriticality: {
      value: metrics.businessCriticality ?? input.inferredBusinessCriticality,
      fallbackIsEvidence: true
    },
    changeSize: { value: changeSize, fallbackIsEvidence: true },
    bugHistory: {
      value:
        metrics.bugCount === undefined
          ? undefined
          : ratioScore(metrics.bugCount, policy.normalization.bugsForMaximum)
    },
    coverageGap: {
      value: metrics.coverage === undefined ? undefined : 100 - clamp(metrics.coverage)
    },
    mutationGap: {
      value: metrics.mutationScore === undefined ? undefined : 100 - clamp(metrics.mutationScore)
    },
    previousFailures: { value: metrics.previousFailureRate },
    changeFrequency: {
      value:
        metrics.changesLast90Days === undefined
          ? undefined
          : ratioScore(metrics.changesLast90Days, policy.normalization.changesForMaximum)
    },
    relatedTestGap: {
      value:
        metrics.relatedTests === undefined
          ? undefined
          : 100 - ratioScore(metrics.relatedTests, policy.normalization.expectedRelatedTests)
    }
  };

  const factors = (Object.keys(policy.weights) as RiskFactorKey[]).map<RiskFactorContribution>((key) => {
    const candidate = values[key];
    const available = candidate?.value !== undefined || candidate?.fallbackIsEvidence === true;
    const score = clamp(candidate?.value ?? policy.fallbacks[key]);
    const weight = policy.weights[key];
    return {
      key,
      score: Math.round(score * 100) / 100,
      weight,
      contribution: Math.round(score * weight) / 100,
      available,
      source: available ? "EVIDENCE" : "CONFIGURED_FALLBACK"
    };
  });

  const rawScore = factors.reduce((total, factor) => total + factor.contribution, 0);
  const score = Math.round(clamp(rawScore));
  const availableWeight = factors
    .filter((factor) => factor.available)
    .reduce((total, factor) => total + factor.weight, 0);
  const missingEvidence = factors
    .filter((factor) => !factor.available)
    .map((factor) => factor.key);

  return {
    score,
    level: classifyRisk(score, policy),
    confidence: availableWeight,
    factors,
    missingEvidence
  };
};
