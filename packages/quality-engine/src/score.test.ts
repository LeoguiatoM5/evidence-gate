import type { RiskAssessment } from "@evidence-gate/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY_POLICY,
  calculateQualityScore,
  evaluateQualityGate,
  type QualityEvidence,
  type QualityPolicy
} from "./index.js";

/**
 * Boundary-first tests. A threshold is only pinned down when both sides of it are
 * asserted, so every rule is exercised exactly at its limit and one step past it.
 */

const risk = (score: number, level: RiskAssessment["level"] = "MEDIUM"): RiskAssessment => ({
  score,
  level,
  confidence: 100,
  factors: [],
  missingEvidence: []
});

const fullEvidence = (overrides: Partial<QualityEvidence> = {}): QualityEvidence => ({
  regression: { passed: 100, failed: 0, criticalFailures: 0 },
  mutationScore: 90,
  api: { passed: 20, failed: 0 },
  flakyRate: 0,
  coverage: 95,
  mitigationCoverage: 100,
  criticalSecurityIssues: 0,
  survivedCriticalMutants: 0,
  ...overrides
});

const componentOf = (evidence: QualityEvidence, key: string, assessment = risk(40)) =>
  calculateQualityScore(assessment, evidence).components.find(
    (component) => component.key === key
  );

const gateFor = (evidence: QualityEvidence, assessment = risk(40), policy?: QualityPolicy) => {
  const quality = calculateQualityScore(assessment, evidence, policy);
  return evaluateQualityGate(assessment, quality, evidence, policy);
};

const codesOf = (evidence: QualityEvidence, assessment = risk(40)): string[] =>
  gateFor(evidence, assessment).reasons.map((reason) => reason.code);

describe("policy validation", () => {
  it("rejects weights that do not total 100", () => {
    const policy: QualityPolicy = {
      ...DEFAULT_QUALITY_POLICY,
      weights: { ...DEFAULT_QUALITY_POLICY.weights, regression: 30 }
    };
    expect(() => calculateQualityScore(risk(10), fullEvidence(), policy)).toThrow(
      /must total 100/
    );
  });

  it("accepts weights that total exactly 100", () => {
    const policy: QualityPolicy = {
      ...DEFAULT_QUALITY_POLICY,
      weights: {
        regression: 50,
        mutation: 10,
        riskControl: 10,
        api: 10,
        testStability: 10,
        coverage: 5,
        evidenceCompleteness: 5
      }
    };
    expect(() => calculateQualityScore(risk(10), fullEvidence(), policy)).not.toThrow();
  });

  it("requires the review threshold to be strictly below the approval threshold", () => {
    const equal: QualityPolicy = {
      ...DEFAULT_QUALITY_POLICY,
      reviewMinimum: 85,
      approvedMinimum: 85
    };
    expect(() => calculateQualityScore(risk(10), fullEvidence(), equal)).toThrow(
      /lower than the approval threshold/
    );

    const above: QualityPolicy = { ...DEFAULT_QUALITY_POLICY, reviewMinimum: 90 };
    expect(() => calculateQualityScore(risk(10), fullEvidence(), above)).toThrow();
  });
});

describe("component scoring", () => {
  it("derives the regression component from the pass rate", () => {
    const component = componentOf(
      fullEvidence({ regression: { passed: 3, failed: 1, criticalFailures: 0 } }),
      "regression"
    );
    expect(component?.score).toBe(75);
    expect(component?.available).toBe(true);
  });

  it("treats a suite that executed nothing as absent evidence, not as a zero", () => {
    const component = componentOf(
      fullEvidence({ regression: { passed: 0, failed: 0, criticalFailures: 0 } }),
      "regression"
    );
    expect(component?.available).toBe(false);
    expect(component?.reason).toContain("INSUFFICIENT EVIDENCE");
    expect(component?.score).toBe(0);
  });

  it("scores stability from the flaky rate against the configured maximum", () => {
    expect(componentOf(fullEvidence({ flakyRate: 0 }), "testStability")?.score).toBe(100);
    // Half of the maximum flaky rate costs half of the component.
    expect(componentOf(fullEvidence({ flakyRate: 5 }), "testStability")?.score).toBe(50);
    // Exactly at the maximum leaves nothing.
    expect(componentOf(fullEvidence({ flakyRate: 10 }), "testStability")?.score).toBe(0);
    // Beyond the maximum is clamped rather than going negative.
    expect(componentOf(fullEvidence({ flakyRate: 40 }), "testStability")?.score).toBe(0);
  });

  it("scores risk control as the residual risk left after mitigation", () => {
    const assessment = risk(80);
    expect(componentOf(fullEvidence({ mitigationCoverage: 100 }), "riskControl", assessment)?.score).toBe(100);
    // Nothing mitigated leaves the whole risk as a penalty: 100 - 80.
    expect(componentOf(fullEvidence({ mitigationCoverage: 0 }), "riskControl", assessment)?.score).toBe(20);
    // Half mitigated halves the penalty: 100 - 80 * 0.5.
    expect(componentOf(fullEvidence({ mitigationCoverage: 50 }), "riskControl", assessment)?.score).toBe(60);
  });

  it("marks risk control absent when no mitigation coverage was reported", () => {
    const component = componentOf(fullEvidence({ mitigationCoverage: undefined }), "riskControl");
    expect(component?.available).toBe(false);
  });

  it("clamps a component score above 100 and below 0", () => {
    expect(componentOf(fullEvidence({ coverage: 140 }), "coverage")?.score).toBe(100);
    expect(componentOf(fullEvidence({ coverage: -20 }), "coverage")?.score).toBe(0);
  });

  it("weights each contribution by the policy weight", () => {
    const component = componentOf(fullEvidence({ coverage: 50 }), "coverage");
    // 50 of 100 on a component worth 10 contributes 5.
    expect(component?.weight).toBe(DEFAULT_QUALITY_POLICY.weights.coverage);
    expect(component?.contribution).toBe(5);
  });
});

describe("evidence completeness and confidence", () => {
  it("reports full confidence when every measurable component has evidence", () => {
    const result = calculateQualityScore(risk(40), fullEvidence());
    expect(result.confidence).toBe(100);
    expect(result.missingEvidence).toEqual([]);
  });

  it("lowers confidence by exactly the weight of the missing evidence", () => {
    const result = calculateQualityScore(risk(40), fullEvidence({ mutationScore: undefined }));
    // Mutation is worth 20 of the 95 measurable weight points.
    expect(result.confidence).toBe(79);
    expect(result.missingEvidence).toEqual(["mutation"]);
  });

  it("names every missing component, in policy order", () => {
    const result = calculateQualityScore(
      risk(40),
      fullEvidence({ mutationScore: undefined, coverage: undefined, api: undefined })
    );
    expect(result.missingEvidence).toEqual(["mutation", "api", "coverage"]);
  });

  it("always keeps evidence completeness itself available", () => {
    const result = calculateQualityScore(risk(40), {});
    const completeness = result.components.find(
      (component) => component.key === "evidenceCompleteness"
    );
    expect(completeness?.available).toBe(true);
    expect(completeness?.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("never returns a score outside 0 to 100", () => {
    expect(calculateQualityScore(risk(0), {}).score).toBe(0);
    expect(calculateQualityScore(risk(0), fullEvidence({ coverage: 100 })).score).toBeLessThanOrEqual(100);
  });
});

describe("gate blockers", () => {
  it("blocks on a critical test failure and reports the count", () => {
    const reasons = gateFor(
      fullEvidence({ regression: { passed: 99, failed: 1, criticalFailures: 1 } })
    ).reasons;
    const failure = reasons.find((reason) => reason.code === "CRITICAL_TEST_FAILURE");
    expect(failure?.severity).toBe("CRITICAL");
    expect(failure?.actual).toBe(1);
    expect(failure?.expected).toBe(0);
  });

  it("does not raise a critical test failure when the count is zero", () => {
    expect(codesOf(fullEvidence())).not.toContain("CRITICAL_TEST_FAILURE");
  });

  it("blocks on a confirmed critical security issue", () => {
    expect(codesOf(fullEvidence({ criticalSecurityIssues: 1 }))).toContain(
      "CRITICAL_SECURITY_ISSUE"
    );
    expect(codesOf(fullEvidence({ criticalSecurityIssues: 0 }))).not.toContain(
      "CRITICAL_SECURITY_ISSUE"
    );
  });

  it("blocks strictly below the mutation minimum, not at it", () => {
    const minimum = DEFAULT_QUALITY_POLICY.mutationMinimum;
    expect(codesOf(fullEvidence({ mutationScore: minimum }))).not.toContain(
      "MUTATION_BELOW_THRESHOLD"
    );
    expect(codesOf(fullEvidence({ mutationScore: minimum - 1 }))).toContain(
      "MUTATION_BELOW_THRESHOLD"
    );
  });

  it("ignores the mutation rule when no mutation score was reported", () => {
    expect(codesOf(fullEvidence({ mutationScore: undefined }))).not.toContain(
      "MUTATION_BELOW_THRESHOLD"
    );
  });

  it("blocks unmitigated critical risk only when the risk level is CRITICAL", () => {
    expect(
      codesOf(fullEvidence({ mitigationCoverage: 0 }), risk(90, "CRITICAL"))
    ).toContain("UNMITIGATED_CRITICAL_RISK");
    // Full mitigation clears it, even at critical risk.
    expect(
      codesOf(fullEvidence({ mitigationCoverage: 100 }), risk(90, "CRITICAL"))
    ).not.toContain("UNMITIGATED_CRITICAL_RISK");
    // The same missing mitigation is not a blocker below critical risk.
    expect(codesOf(fullEvidence({ mitigationCoverage: 0 }), risk(70, "HIGH"))).not.toContain(
      "UNMITIGATED_CRITICAL_RISK"
    );
  });

  it("reports missing mitigation coverage as insufficient evidence in the reason", () => {
    const reason = gateFor(
      fullEvidence({ mitigationCoverage: undefined }),
      risk(90, "CRITICAL")
    ).reasons.find((item) => item.code === "UNMITIGATED_CRITICAL_RISK");
    expect(reason?.actual).toBe("INSUFFICIENT EVIDENCE");
  });

  it("blocks strictly below the review threshold, not at it", () => {
    const policy: QualityPolicy = {
      ...DEFAULT_QUALITY_POLICY,
      weights: {
        regression: 100,
        mutation: 0,
        riskControl: 0,
        api: 0,
        testStability: 0,
        coverage: 0,
        evidenceCompleteness: 0
      }
    };
    // A regression pass rate equal to the review threshold is not blocked.
    const atThreshold = gateFor(
      fullEvidence({ regression: { passed: 65, failed: 35, criticalFailures: 0 } }),
      risk(40),
      policy
    );
    expect(atThreshold.decision).not.toBe("RELEASE_BLOCKED");

    const below = gateFor(
      fullEvidence({ regression: { passed: 64, failed: 36, criticalFailures: 0 } }),
      risk(40),
      policy
    );
    expect(below.decision).toBe("RELEASE_BLOCKED");
    expect(below.reasons.map((reason) => reason.code)).toContain("QUALITY_SCORE_BLOCKED");
  });
});

describe("gate warnings", () => {
  it("treats a survived critical mutant as a warning, not as a blocker", () => {
    const gate = gateFor(fullEvidence({ survivedCriticalMutants: 3 }));
    const reason = gate.reasons.find((item) => item.code === "CRITICAL_SURVIVED_MUTANT");
    expect(reason?.severity).toBe("WARNING");
    expect(reason?.actual).toBe(3);
    expect(gate.decision).toBe("REVIEW_REQUIRED");
    // With the default budget of zero the wording is absolute, not a budget overrun.
    expect(reason?.message).toBe("Survived mutants exist in a critical area.");
    expect(reason?.expected).toBe("<= 0");
  });

  it("warns above the recorded budget, not at it", () => {
    const budget: QualityPolicy = {
      ...DEFAULT_QUALITY_POLICY,
      maximumSurvivedCriticalMutants: 65
    };
    // A project that already carries survivors records the count as a ratchet, so
    // only a new survivor raises the warning.
    expect(
      gateFor(fullEvidence({ survivedCriticalMutants: 65 }), risk(40), budget).reasons.map(
        (reason) => reason.code
      )
    ).not.toContain("CRITICAL_SURVIVED_MUTANT");

    const exceeded = gateFor(
      fullEvidence({ survivedCriticalMutants: 66 }),
      risk(40),
      budget
    ).reasons.find((reason) => reason.code === "CRITICAL_SURVIVED_MUTANT");
    expect(exceeded?.actual).toBe(66);
    expect(exceeded?.expected).toBe("<= 65");
    expect(exceeded?.message).toContain("exceed the recorded budget");
  });

  it("rejects a budget that is negative or fractional", () => {
    expect(() =>
      calculateQualityScore(risk(10), fullEvidence(), {
        ...DEFAULT_QUALITY_POLICY,
        maximumSurvivedCriticalMutants: -1
      })
    ).toThrow(/non-negative integer/);
    expect(() =>
      calculateQualityScore(risk(10), fullEvidence(), {
        ...DEFAULT_QUALITY_POLICY,
        maximumSurvivedCriticalMutants: 1.5
      })
    ).toThrow(/non-negative integer/);
  });

  it("does not warn about survivors when there are none", () => {
    expect(codesOf(fullEvidence({ survivedCriticalMutants: 0 }))).not.toContain(
      "CRITICAL_SURVIVED_MUTANT"
    );
  });

  it("warns below the confidence minimum, not at it", () => {
    const atMinimum: QualityPolicy = { ...DEFAULT_QUALITY_POLICY, minimumConfidence: 79 };
    expect(
      gateFor(fullEvidence({ mutationScore: undefined }), risk(40), atMinimum).reasons.map(
        (reason) => reason.code
      )
    ).not.toContain("LOW_EVIDENCE_CONFIDENCE");

    const aboveMinimum: QualityPolicy = { ...DEFAULT_QUALITY_POLICY, minimumConfidence: 80 };
    expect(
      gateFor(fullEvidence({ mutationScore: undefined }), risk(40), aboveMinimum).reasons.map(
        (reason) => reason.code
      )
    ).toContain("LOW_EVIDENCE_CONFIDENCE");
  });

  it("lists the missing components in the insufficient evidence reason", () => {
    const reason = gateFor(fullEvidence({ coverage: undefined })).reasons.find(
      (item) => item.code === "INSUFFICIENT_EVIDENCE"
    );
    expect(reason?.message).toContain("coverage");
    expect(reason?.severity).toBe("WARNING");
  });
});

describe("decisions", () => {
  it("approves only when every condition holds", () => {
    const gate = gateFor(fullEvidence(), risk(20, "LOW"));
    expect(gate.decision).toBe("RELEASE_APPROVED");
    expect(gate.reasons.map((reason) => reason.code)).toContain("ALL_APPROVAL_RULES_SATISFIED");
  });

  it("requires review strictly below the approval threshold, not at it", () => {
    const policy: QualityPolicy = {
      ...DEFAULT_QUALITY_POLICY,
      weights: {
        regression: 100,
        mutation: 0,
        riskControl: 0,
        api: 0,
        testStability: 0,
        coverage: 0,
        evidenceCompleteness: 0
      }
    };
    const atThreshold = gateFor(
      fullEvidence({ regression: { passed: 85, failed: 15, criticalFailures: 0 } }),
      risk(20, "LOW"),
      policy
    );
    expect(atThreshold.decision).toBe("RELEASE_APPROVED");

    const below = gateFor(
      fullEvidence({ regression: { passed: 84, failed: 16, criticalFailures: 0 } }),
      risk(20, "LOW"),
      policy
    );
    expect(below.decision).toBe("REVIEW_REQUIRED");
    expect(below.reasons.map((reason) => reason.code)).toContain("MANUAL_REVIEW_REQUIRED");
  });

  it("lets a blocker win over a perfect score", () => {
    const gate = gateFor(
      fullEvidence({ regression: { passed: 1000, failed: 0, criticalFailures: 1 } }),
      risk(10, "LOW")
    );
    expect(gate.decision).toBe("RELEASE_BLOCKED");
  });

  it("never approves while any evidence is missing", () => {
    const gate = gateFor(fullEvidence({ coverage: undefined }), risk(10, "LOW"));
    expect(gate.decision).toBe("REVIEW_REQUIRED");
  });

  it("reports every rule it evaluated, whether or not it fired", () => {
    const gate = gateFor(fullEvidence(), risk(20, "LOW"));
    expect(gate.evaluatedRules).toEqual([
      "CRITICAL_TEST_FAILURE",
      "CRITICAL_SECURITY_ISSUE",
      "MUTATION_THRESHOLD",
      "UNMITIGATED_CRITICAL_RISK",
      "QUALITY_SCORE",
      "EVIDENCE_CONFIDENCE",
      "CRITICAL_SURVIVED_MUTANT"
    ]);
  });
});
