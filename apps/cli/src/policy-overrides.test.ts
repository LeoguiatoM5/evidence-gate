import { DEFAULT_QUALITY_POLICY } from "@evidence-gate/quality-engine";
import { DEFAULT_RISK_POLICY } from "@evidence-gate/risk-engine";
import { describe, expect, it } from "vitest";
import { PolicyOverrideError, describePolicyVersion, resolvePolicies } from "./policy-overrides.js";

describe("project policy overrides", () => {
  it("uses the defaults when the project declares nothing", () => {
    const resolved = resolvePolicies({});

    expect(resolved.customised).toBe(false);
    expect(resolved.quality.weights).toEqual(DEFAULT_QUALITY_POLICY.weights);
    expect(resolved.risk.weights).toEqual(DEFAULT_RISK_POLICY.weights);
    expect(describePolicyVersion(resolved)).toBe("risk-v1+quality-v1");
  });

  it("merges a partial weight map instead of replacing it", () => {
    const resolved = resolvePolicies({
      qualityPolicy: { weights: { mutation: 8, coverage: 5, regression: 42 } }
    });

    expect(resolved.quality.weights.mutation).toBe(8);
    expect(resolved.quality.weights.coverage).toBe(5);
    expect(resolved.quality.weights.regression).toBe(42);
    // Untouched keys keep the default value.
    expect(resolved.quality.weights.api).toBe(DEFAULT_QUALITY_POLICY.weights.api);
    expect(resolved.customised).toBe(true);
  });

  it("overrides thresholds and reports the customisation in the version", () => {
    const resolved = resolvePolicies({
      qualityPolicy: { version: "quality-v1-acme", approvedMinimum: 90, mutationMinimum: 60 }
    });

    expect(resolved.quality.approvedMinimum).toBe(90);
    expect(resolved.quality.mutationMinimum).toBe(60);
    expect(resolved.quality.reviewMinimum).toBe(DEFAULT_QUALITY_POLICY.reviewMinimum);
    expect(describePolicyVersion(resolved)).toBe("risk-v1+quality-v1-acme (project override)");
  });

  it("reads the survived critical mutant budget", () => {
    const resolved = resolvePolicies({
      qualityPolicy: { maximumSurvivedCriticalMutants: 65 }
    });
    expect(resolved.quality.maximumSurvivedCriticalMutants).toBe(65);
    expect(resolvePolicies({}).quality.maximumSurvivedCriticalMutants).toBe(0);
  });

  it("rejects an unknown key rather than silently ignoring it", () => {
    expect(() => resolvePolicies({ qualityPolicy: { weights: { chaos: 10 } } })).toThrow(
      PolicyOverrideError
    );
    expect(() => resolvePolicies({ riskPolicy: { weights: { vibes: 5 } } })).toThrow(
      PolicyOverrideError
    );
  });

  it("rejects a non-numeric weight and a non-object policy", () => {
    expect(() => resolvePolicies({ qualityPolicy: { weights: { mutation: "high" } } })).toThrow(
      PolicyOverrideError
    );
    expect(() => resolvePolicies({ riskPolicy: "aggressive" })).toThrow(PolicyOverrideError);
  });

  it("still lets the engine reject weights that do not total 100", () => {
    const resolved = resolvePolicies({ qualityPolicy: { weights: { regression: 90 } } });
    const total = Object.values(resolved.quality.weights).reduce((sum, w) => sum + w, 0);

    // resolvePolicies merges; the engine is what enforces the invariant.
    expect(total).not.toBe(100);
  });

  it("keeps risk levels and normalisation mergeable", () => {
    const resolved = resolvePolicies({
      riskPolicy: { levels: { critical: 70 }, normalization: { changedLinesForMaximum: 200 } }
    });

    expect(resolved.risk.levels.critical).toBe(70);
    expect(resolved.risk.levels.high).toBe(DEFAULT_RISK_POLICY.levels.high);
    expect(resolved.risk.normalization.changedLinesForMaximum).toBe(200);
    expect(resolved.risk.normalization.bugsForMaximum).toBe(
      DEFAULT_RISK_POLICY.normalization.bugsForMaximum
    );
  });
});
