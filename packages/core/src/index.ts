export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RELEASE_DECISIONS = [
  "RELEASE_APPROVED",
  "REVIEW_REQUIRED",
  "RELEASE_BLOCKED"
] as const;
export type ReleaseDecision = (typeof RELEASE_DECISIONS)[number];

export const GIT_CHANGE_TYPES = ["ADDED", "MODIFIED", "DELETED", "RENAMED"] as const;
export type GitChangeType = (typeof GIT_CHANGE_TYPES)[number];

export interface GitChange {
  path: string;
  oldPath: string | null;
  type: GitChangeType;
  additions: number;
  deletions: number;
  extension: string | null;
  area: string;
  businessCriticality: number;
}

export interface RepositoryAnalysis {
  diffHash: string;
  changes: GitChange[];
  affectedAreas: string[];
  totalAdditions: number;
  totalDeletions: number;
  totalChangedLines: number;
}

export type RiskFactorKey =
  | "businessCriticality"
  | "changeSize"
  | "bugHistory"
  | "coverageGap"
  | "mutationGap"
  | "previousFailures"
  | "changeFrequency"
  | "relatedTestGap";

export interface RiskFactorContribution {
  key: RiskFactorKey;
  score: number;
  weight: number;
  contribution: number;
  available: boolean;
  source: "EVIDENCE" | "CONFIGURED_FALLBACK";
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  confidence: number;
  factors: RiskFactorContribution[];
  missingEvidence: RiskFactorKey[];
}

export type QualityComponentKey =
  | "regression"
  | "mutation"
  | "riskControl"
  | "api"
  | "testStability"
  | "coverage"
  | "evidenceCompleteness";

export interface QualityComponent {
  key: QualityComponentKey;
  score: number;
  weight: number;
  contribution: number;
  available: boolean;
  reason: string;
}

export interface QualityScoreResult {
  score: number;
  confidence: number;
  components: QualityComponent[];
  missingEvidence: QualityComponentKey[];
}

export interface GateReason {
  code: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  actual?: number | string;
  expected?: number | string;
}

export interface QualityGateResult {
  decision: ReleaseDecision;
  reasons: GateReason[];
  evaluatedRules: string[];
}

export * from "./execution.js";
export * from "./redaction.js";
