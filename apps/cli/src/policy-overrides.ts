import type { QualityComponentKey, RiskFactorKey } from "@evidence-gate/core";
import type { QualityPolicy } from "@evidence-gate/quality-engine";
import { DEFAULT_QUALITY_POLICY } from "@evidence-gate/quality-engine";
import type { RiskPolicy } from "@evidence-gate/risk-engine";
import { DEFAULT_RISK_POLICY } from "@evidence-gate/risk-engine";

/**
 * A project declares what it actually measures. Weights and thresholds are policy,
 * not universal truth: a team without mutation testing should say so rather than be
 * scored against evidence it never produces.
 *
 * What configuration cannot do is silence a gap. A component with weight zero is
 * still reported as missing evidence, still lowers confidence, and still prevents an
 * automatic approval — only its share of the score changes.
 */

export class PolicyOverrideError extends Error {
  public readonly code = "POLICY_OVERRIDE_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "PolicyOverrideError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolicyOverrideError(`${path} must be a finite number.`);
  }
  return value;
};

const mergeNumberMap = <K extends string>(
  defaults: Record<K, number>,
  override: unknown,
  path: string
): Record<K, number> => {
  if (override === undefined) return { ...defaults };
  if (!isRecord(override)) throw new PolicyOverrideError(`${path} must be an object.`);

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in defaults)) {
      throw new PolicyOverrideError(
        `${path}.${key} is not a known key; expected one of ${Object.keys(defaults).join(", ")}.`
      );
    }
    merged[key as K] = readNumber(value, `${path}.${key}`);
  }
  return merged;
};

const readOptionalNumber = (
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string
): number => (source[key] === undefined ? fallback : readNumber(source[key], `${path}.${key}`));

export interface ResolvedPolicies {
  risk: RiskPolicy;
  quality: QualityPolicy;
  /** True when the project changed anything, so the report can say so. */
  customised: boolean;
}

export const resolvePolicies = (raw: Record<string, unknown>): ResolvedPolicies => {
  const riskRaw = raw.riskPolicy;
  const qualityRaw = raw.qualityPolicy;
  const customised = riskRaw !== undefined || qualityRaw !== undefined;

  if (riskRaw !== undefined && !isRecord(riskRaw)) {
    throw new PolicyOverrideError("riskPolicy must be an object.");
  }
  if (qualityRaw !== undefined && !isRecord(qualityRaw)) {
    throw new PolicyOverrideError("qualityPolicy must be an object.");
  }

  const riskSource = isRecord(riskRaw) ? riskRaw : {};
  const qualitySource = isRecord(qualityRaw) ? qualityRaw : {};

  const risk: RiskPolicy = {
    ...DEFAULT_RISK_POLICY,
    version:
      typeof riskSource.version === "string" ? riskSource.version : DEFAULT_RISK_POLICY.version,
    weights: mergeNumberMap<RiskFactorKey>(
      DEFAULT_RISK_POLICY.weights,
      riskSource.weights,
      "riskPolicy.weights"
    ),
    fallbacks: mergeNumberMap<RiskFactorKey>(
      DEFAULT_RISK_POLICY.fallbacks,
      riskSource.fallbacks,
      "riskPolicy.fallbacks"
    ),
    normalization: {
      ...DEFAULT_RISK_POLICY.normalization,
      ...mergeNumberMap(
        DEFAULT_RISK_POLICY.normalization,
        riskSource.normalization,
        "riskPolicy.normalization"
      )
    },
    levels: {
      ...DEFAULT_RISK_POLICY.levels,
      ...mergeNumberMap(DEFAULT_RISK_POLICY.levels, riskSource.levels, "riskPolicy.levels")
    }
  };

  const quality: QualityPolicy = {
    ...DEFAULT_QUALITY_POLICY,
    version:
      typeof qualitySource.version === "string"
        ? qualitySource.version
        : DEFAULT_QUALITY_POLICY.version,
    weights: mergeNumberMap<QualityComponentKey>(
      DEFAULT_QUALITY_POLICY.weights,
      qualitySource.weights,
      "qualityPolicy.weights"
    ),
    approvedMinimum: readOptionalNumber(
      qualitySource,
      "approvedMinimum",
      DEFAULT_QUALITY_POLICY.approvedMinimum,
      "qualityPolicy"
    ),
    reviewMinimum: readOptionalNumber(
      qualitySource,
      "reviewMinimum",
      DEFAULT_QUALITY_POLICY.reviewMinimum,
      "qualityPolicy"
    ),
    mutationMinimum: readOptionalNumber(
      qualitySource,
      "mutationMinimum",
      DEFAULT_QUALITY_POLICY.mutationMinimum,
      "qualityPolicy"
    ),
    maximumFlakyRate: readOptionalNumber(
      qualitySource,
      "maximumFlakyRate",
      DEFAULT_QUALITY_POLICY.maximumFlakyRate,
      "qualityPolicy"
    ),
    minimumConfidence: readOptionalNumber(
      qualitySource,
      "minimumConfidence",
      DEFAULT_QUALITY_POLICY.minimumConfidence,
      "qualityPolicy"
    ),
    maximumSurvivedCriticalMutants: readOptionalNumber(
      qualitySource,
      "maximumSurvivedCriticalMutants",
      DEFAULT_QUALITY_POLICY.maximumSurvivedCriticalMutants,
      "qualityPolicy"
    )
  };

  return { risk, quality, customised };
};

export const describePolicyVersion = (policies: ResolvedPolicies): string =>
  `${policies.risk.version}+${policies.quality.version}${policies.customised ? " (project override)" : ""}`;
