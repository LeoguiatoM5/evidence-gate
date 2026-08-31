import { describe, expect, it } from "vitest";
import { assessRisk, DEFAULT_RISK_POLICY } from "./index.js";

describe("assessRisk", () => {
  it("calculates a fully evidenced critical risk with explainable contributions", () => {
    const result = assessRisk({
      changedFiles: 20,
      changedLines: 500,
      inferredBusinessCriticality: 95,
      metrics: {
        bugCount: 10,
        coverage: 20,
        mutationScore: 20,
        previousFailureRate: 90,
        changesLast90Days: 20,
        relatedTests: 0
      }
    });

    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe("CRITICAL");
    expect(result.confidence).toBe(100);
    expect(result.missingEvidence).toEqual([]);
    expect(result.factors.reduce((sum, factor) => sum + factor.weight, 0)).toBe(100);
  });

  it("uses conservative fallbacks and lowers confidence when evidence is absent", () => {
    const result = assessRisk({
      changedFiles: 1,
      changedLines: 10,
      inferredBusinessCriticality: 50
    });

    expect(result.missingEvidence).toEqual([
      "bugHistory",
      "coverageGap",
      "mutationGap",
      "previousFailures",
      "changeFrequency",
      "relatedTestGap"
    ]);
    expect(result.confidence).toBe(40);
    expect(result.factors.find((factor) => factor.key === "mutationGap")?.source).toBe(
      "CONFIGURED_FALLBACK"
    );
  });

  it.each([
    [29, "LOW"],
    [30, "MEDIUM"],
    [59, "MEDIUM"],
    [60, "HIGH"],
    [79, "HIGH"],
    [80, "CRITICAL"]
  ])("classifies boundary score %i as %s", (targetScore, expectedLevel) => {
    const policy = {
      ...DEFAULT_RISK_POLICY,
      weights: {
        ...DEFAULT_RISK_POLICY.weights,
        businessCriticality: 100,
        changeSize: 0,
        bugHistory: 0,
        coverageGap: 0,
        mutationGap: 0,
        previousFailures: 0,
        changeFrequency: 0,
        relatedTestGap: 0
      }
    };
    const result = assessRisk(
      { changedFiles: 0, changedLines: 0, inferredBusinessCriticality: targetScore },
      policy
    );
    expect(result.level).toBe(expectedLevel);
  });
});
