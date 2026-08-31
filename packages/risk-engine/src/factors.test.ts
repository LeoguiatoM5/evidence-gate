import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_POLICY, assessRisk, type RiskInput, type RiskPolicy } from "./index.js";

/**
 * Boundary-first tests for the risk factors. Each factor is isolated by zeroing the
 * other weights, so an assertion pins down that factor's formula and nothing else.
 */

const baseInput = (overrides: Partial<RiskInput> = {}): RiskInput => ({
  changedFiles: 1,
  changedLines: 1,
  inferredBusinessCriticality: 0,
  ...overrides
});

/** A policy where a single factor carries the whole score. */
const onlyFactor = (key: keyof RiskPolicy["weights"]): RiskPolicy => {
  const weights = Object.fromEntries(
    Object.keys(DEFAULT_RISK_POLICY.weights).map((name) => [name, name === key ? 100 : 0])
  ) as RiskPolicy["weights"];
  return { ...DEFAULT_RISK_POLICY, weights };
};

const scoreOf = (input: RiskInput, key: keyof RiskPolicy["weights"]): number =>
  assessRisk(input, onlyFactor(key)).score;

const factorOf = (input: RiskInput, key: string) =>
  assessRisk(input).factors.find((factor) => factor.key === key);

describe("policy validation", () => {
  it("rejects weights that do not total 100", () => {
    const policy: RiskPolicy = {
      ...DEFAULT_RISK_POLICY,
      weights: { ...DEFAULT_RISK_POLICY.weights, businessCriticality: 5 }
    };
    expect(() => assessRisk(baseInput(), policy)).toThrow(/must total 100/);
  });

  it("requires strictly increasing risk thresholds", () => {
    const equal: RiskPolicy = {
      ...DEFAULT_RISK_POLICY,
      levels: { medium: 30, high: 30, critical: 80 }
    };
    expect(() => assessRisk(baseInput(), equal)).toThrow(/strictly increasing/);

    const inverted: RiskPolicy = {
      ...DEFAULT_RISK_POLICY,
      levels: { medium: 70, high: 60, critical: 80 }
    };
    expect(() => assessRisk(baseInput(), inverted)).toThrow(/strictly increasing/);
  });
});

describe("factor formulas", () => {
  it("takes business criticality from the metric, falling back to the inferred value", () => {
    expect(scoreOf(baseInput({ inferredBusinessCriticality: 60 }), "businessCriticality")).toBe(60);
    // An explicit metric wins over what the diff inferred.
    expect(
      scoreOf(
        baseInput({ inferredBusinessCriticality: 60, metrics: { businessCriticality: 20 } }),
        "businessCriticality"
      )
    ).toBe(20);
  });

  it("weights changed lines more than changed files", () => {
    // Lines carry 0.7 of the change size, files 0.3.
    const linesOnly = scoreOf(baseInput({ changedLines: 500, changedFiles: 0 }), "changeSize");
    const filesOnly = scoreOf(baseInput({ changedLines: 0, changedFiles: 20 }), "changeSize");
    expect(linesOnly).toBe(70);
    expect(filesOnly).toBe(30);
  });

  it("caps change size at the configured maximum instead of growing without bound", () => {
    const atMaximum = scoreOf(baseInput({ changedLines: 500, changedFiles: 20 }), "changeSize");
    const farBeyond = scoreOf(baseInput({ changedLines: 50_000, changedFiles: 900 }), "changeSize");
    expect(atMaximum).toBe(100);
    expect(farBeyond).toBe(100);
  });

  it("turns coverage into a gap", () => {
    expect(scoreOf(baseInput({ metrics: { coverage: 100 } }), "coverageGap")).toBe(0);
    expect(scoreOf(baseInput({ metrics: { coverage: 60 } }), "coverageGap")).toBe(40);
    expect(scoreOf(baseInput({ metrics: { coverage: 0 } }), "coverageGap")).toBe(100);
    // A nonsensical coverage above 100 is clamped rather than producing a negative gap.
    expect(scoreOf(baseInput({ metrics: { coverage: 130 } }), "coverageGap")).toBe(0);
  });

  it("turns the mutation score into a gap", () => {
    expect(scoreOf(baseInput({ metrics: { mutationScore: 90 } }), "mutationGap")).toBe(10);
    expect(scoreOf(baseInput({ metrics: { mutationScore: 0 } }), "mutationGap")).toBe(100);
  });

  it("scales bug history against the configured maximum", () => {
    expect(scoreOf(baseInput({ metrics: { bugCount: 0 } }), "bugHistory")).toBe(0);
    expect(scoreOf(baseInput({ metrics: { bugCount: 5 } }), "bugHistory")).toBe(50);
    expect(scoreOf(baseInput({ metrics: { bugCount: 10 } }), "bugHistory")).toBe(100);
    expect(scoreOf(baseInput({ metrics: { bugCount: 40 } }), "bugHistory")).toBe(100);
  });

  it("scales change frequency against the configured maximum", () => {
    expect(scoreOf(baseInput({ metrics: { changesLast90Days: 10 } }), "changeFrequency")).toBe(50);
    expect(scoreOf(baseInput({ metrics: { changesLast90Days: 20 } }), "changeFrequency")).toBe(100);
  });

  it("turns related tests into a gap that closes at the expected count", () => {
    expect(scoreOf(baseInput({ metrics: { relatedTests: 0 } }), "relatedTestGap")).toBe(100);
    expect(scoreOf(baseInput({ metrics: { relatedTests: 5 } }), "relatedTestGap")).toBe(0);
    // More tests than expected does not produce a negative gap.
    expect(scoreOf(baseInput({ metrics: { relatedTests: 50 } }), "relatedTestGap")).toBe(0);
  });

  it("uses the previous failure rate directly", () => {
    expect(scoreOf(baseInput({ metrics: { previousFailureRate: 35 } }), "previousFailures")).toBe(35);
  });
});

describe("missing evidence", () => {
  it("marks a metric-backed factor as a configured fallback when it is absent", () => {
    const factor = factorOf(baseInput(), "bugHistory");
    expect(factor?.available).toBe(false);
    expect(factor?.source).toBe("CONFIGURED_FALLBACK");
    expect(factor?.score).toBe(DEFAULT_RISK_POLICY.fallbacks.bugHistory);
  });

  it("treats criticality and change size as evidence even without metrics", () => {
    // Both are derived from the diff itself, so they are always known.
    expect(factorOf(baseInput(), "businessCriticality")?.available).toBe(true);
    expect(factorOf(baseInput(), "businessCriticality")?.source).toBe("EVIDENCE");
    expect(factorOf(baseInput(), "changeSize")?.available).toBe(true);
  });

  it("sets confidence to the weight actually backed by evidence", () => {
    const nothing = assessRisk(baseInput());
    // Only criticality (25) and change size (15) are known from the diff.
    expect(nothing.confidence).toBe(40);
    expect(nothing.missingEvidence).toEqual([
      "bugHistory",
      "coverageGap",
      "mutationGap",
      "previousFailures",
      "changeFrequency",
      "relatedTestGap"
    ]);

    const everything = assessRisk(
      baseInput({
        metrics: {
          bugCount: 0,
          coverage: 90,
          mutationScore: 90,
          previousFailureRate: 0,
          changesLast90Days: 1,
          relatedTests: 5
        }
      })
    );
    expect(everything.confidence).toBe(100);
    expect(everything.missingEvidence).toEqual([]);
  });
});

describe("classification", () => {
  const atScore = (target: number) =>
    assessRisk(
      baseInput({ inferredBusinessCriticality: target }),
      onlyFactor("businessCriticality")
    );

  it("classifies at the threshold, not above it", () => {
    expect(atScore(29).level).toBe("LOW");
    expect(atScore(30).level).toBe("MEDIUM");
    expect(atScore(59).level).toBe("MEDIUM");
    expect(atScore(60).level).toBe("HIGH");
    expect(atScore(79).level).toBe("HIGH");
    expect(atScore(80).level).toBe("CRITICAL");
  });

  it("keeps the score inside 0 to 100", () => {
    expect(atScore(0).score).toBe(0);
    expect(atScore(100).score).toBe(100);
  });

  it("keeps every factor contribution explainable and weighted", () => {
    const assessment = assessRisk(baseInput({ inferredBusinessCriticality: 100 }));
    const criticality = assessment.factors.find((factor) => factor.key === "businessCriticality");

    expect(criticality?.weight).toBe(DEFAULT_RISK_POLICY.weights.businessCriticality);
    expect(criticality?.contribution).toBe(25);
    expect(assessment.factors).toHaveLength(
      Object.keys(DEFAULT_RISK_POLICY.weights).length
    );
  });
});
