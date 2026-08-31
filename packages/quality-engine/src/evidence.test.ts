import { describe, expect, it } from "vitest";
import { buildQualityEvidence, type ExecutedSuite } from "./evidence.js";
import { selectTests, type AvailableSuite } from "./selection.js";
import { TEST_SELECTION_STRATEGIES, type RiskLevel } from "@evidence-gate/core";

const suite = (kind: string, results: ExecutedSuite["results"]): ExecutedSuite => ({
  kind,
  results
});

const result = (
  status: string,
  overrides: { critical?: boolean; retries?: number } = {}
): ExecutedSuite["results"][number] => ({
  status,
  critical: overrides.critical ?? false,
  retries: overrides.retries ?? 0
});

describe("evidence derived from execution", () => {
  it("counts SMOKE and REGRESSION into regression, and API separately", () => {
    const evidence = buildQualityEvidence(
      [
        suite("SMOKE", [result("PASSED")]),
        suite("REGRESSION", [result("PASSED"), result("FAILED")]),
        suite("API", [result("PASSED")])
      ],
      {}
    );

    expect(evidence.regression).toEqual({ passed: 2, failed: 1, criticalFailures: 0 });
    expect(evidence.api).toEqual({ passed: 1, failed: 0 });
  });

  it("ignores a suite of an unknown kind rather than guessing where it belongs", () => {
    const evidence = buildQualityEvidence([suite("CHAOS", [result("FAILED")])], {});
    expect(evidence.regression).toBeUndefined();
    expect(evidence.api).toBeUndefined();
    expect(evidence.flakyRate).toBeUndefined();
  });

  it("does not count a skipped test as executed", () => {
    const evidence = buildQualityEvidence(
      [suite("REGRESSION", [result("PASSED"), result("SKIPPED"), result("SKIPPED")])],
      {}
    );
    expect(evidence.regression).toEqual({ passed: 1, failed: 0, criticalFailures: 0 });
    // Three results, but only one counts towards the flaky denominator.
    expect(evidence.flakyRate).toBe(0);
  });

  it("counts a timeout as a failure, not as a pass", () => {
    const evidence = buildQualityEvidence(
      [suite("REGRESSION", [result("TIMED_OUT"), result("FAILED")])],
      {}
    );
    expect(evidence.regression).toEqual({ passed: 0, failed: 2, criticalFailures: 0 });
  });

  it("counts only critical failures towards criticalFailures", () => {
    const evidence = buildQualityEvidence(
      [
        suite("REGRESSION", [
          result("FAILED", { critical: true }),
          result("FAILED", { critical: false }),
          result("PASSED", { critical: true })
        ])
      ],
      {}
    );
    expect(evidence.regression).toEqual({ passed: 1, failed: 2, criticalFailures: 1 });
  });

  it("treats a flaky test as passed and as flaky at the same time", () => {
    const evidence = buildQualityEvidence(
      [suite("REGRESSION", [result("FLAKY"), result("PASSED"), result("PASSED"), result("PASSED")])],
      {}
    );
    expect(evidence.regression?.passed).toBe(4);
    expect(evidence.regression?.failed).toBe(0);
    expect(evidence.flakyRate).toBe(25);
  });

  it("counts a test that needed a retry as flaky even when its status is PASSED", () => {
    const evidence = buildQualityEvidence(
      [suite("REGRESSION", [result("PASSED", { retries: 1 }), result("PASSED")])],
      {}
    );
    expect(evidence.flakyRate).toBe(50);
  });

  it("does not count a failed test as flaky, whatever its retry count", () => {
    const evidence = buildQualityEvidence(
      [suite("REGRESSION", [result("FAILED", { retries: 3 }), result("PASSED")])],
      {}
    );
    expect(evidence.flakyRate).toBe(0);
  });

  it("computes the flaky rate across regression and API together", () => {
    const evidence = buildQualityEvidence(
      [
        suite("REGRESSION", [result("FLAKY"), result("PASSED")]),
        suite("API", [result("PASSED"), result("PASSED")])
      ],
      {}
    );
    // One flaky out of four executed tests.
    expect(evidence.flakyRate).toBe(25);
  });

  it("rounds the flaky rate to two decimals", () => {
    const evidence = buildQualityEvidence(
      [suite("REGRESSION", [result("FLAKY"), result("PASSED"), result("PASSED")])],
      {}
    );
    expect(evidence.flakyRate).toBe(33.33);
  });

  it("passes every supplied metric through untouched", () => {
    const evidence = buildQualityEvidence([], {
      mutationScore: 61,
      coverage: 72,
      mitigationCoverage: 40,
      criticalSecurityIssues: 2,
      survivedCriticalMutants: 5
    });

    expect(evidence.mutationScore).toBe(61);
    expect(evidence.coverage).toBe(72);
    expect(evidence.mitigationCoverage).toBe(40);
    expect(evidence.criticalSecurityIssues).toBe(2);
    expect(evidence.survivedCriticalMutants).toBe(5);
  });

  it("keeps a supplied zero instead of dropping it as absent", () => {
    const evidence = buildQualityEvidence([], {
      mutationScore: 0,
      criticalSecurityIssues: 0,
      survivedCriticalMutants: 0
    });

    expect(evidence.mutationScore).toBe(0);
    expect(evidence.criticalSecurityIssues).toBe(0);
    expect(evidence.survivedCriticalMutants).toBe(0);
  });

  it("leaves a metric absent when nothing supplied it", () => {
    const evidence = buildQualityEvidence([], {});
    expect(evidence.mutationScore).toBeUndefined();
    expect(evidence.coverage).toBeUndefined();
    expect(evidence.mitigationCoverage).toBeUndefined();
    expect(evidence.criticalSecurityIssues).toBeUndefined();
    expect(evidence.survivedCriticalMutants).toBeUndefined();
  });
});

describe("selection strategy", () => {
  const every: AvailableSuite[] = [
    { key: "smoke", kind: "SMOKE" },
    { key: "regression", kind: "REGRESSION" },
    { key: "api", kind: "API" }
  ];

  it("names a distinct strategy per risk level", () => {
    const strategies = (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as RiskLevel[]).map(
      (level) => selectTests(level, every).strategy
    );
    expect(strategies).toEqual([
      "SMOKE",
      "SMOKE_AND_RELATED",
      "PARTIAL_REGRESSION_AND_API",
      "FULL_REGRESSION_AND_API"
    ]);
    for (const strategy of strategies) {
      expect(TEST_SELECTION_STRATEGIES).toContain(strategy);
    }
  });

  it("runs only smoke below high risk", () => {
    expect(selectTests("LOW", every).suiteKeys).toEqual(["smoke"]);
    expect(selectTests("MEDIUM", every).suiteKeys).toEqual(["smoke"]);
  });

  it("adds regression and API from high risk upwards", () => {
    expect(selectTests("HIGH", every).suiteKeys).toEqual(["smoke", "regression", "api"]);
    expect(selectTests("CRITICAL", every).suiteKeys).toEqual(["smoke", "regression", "api"]);
  });

  it("preserves the declared order of the allow list", () => {
    const reversed: AvailableSuite[] = [
      { key: "api", kind: "API" },
      { key: "regression", kind: "REGRESSION" },
      { key: "smoke", kind: "SMOKE" }
    ];
    expect(selectTests("CRITICAL", reversed).suiteKeys).toEqual(["api", "regression", "smoke"]);
  });

  it("explains the medium strategy without claiming impact selection it cannot do", () => {
    const reason = selectTests("MEDIUM", every).reason;
    expect(reason).toContain("test impact map");
    expect(reason).not.toContain("every allow-listed suite ran instead");
  });

  it("falls back to every suite when none matches the preferred kinds", () => {
    const selection = selectTests("LOW", [
      { key: "unit", kind: "REGRESSION" },
      { key: "contract", kind: "API" }
    ]);
    expect(selection.suiteKeys).toEqual(["unit", "contract"]);
    expect(selection.strategy).toBe("SMOKE");
    expect(selection.reason).toContain("every allow-listed suite ran instead");
  });

  it("reports that no evidence is possible when the allow list is empty", () => {
    const selection = selectTests("CRITICAL", []);
    expect(selection.suiteKeys).toEqual([]);
    expect(selection.reason).toContain("no test evidence will be produced");
    expect(selection.reason).not.toContain("every allow-listed suite ran instead");
  });
});
