import { describe, expect, it } from "vitest";
import { buildQualityEvidence, type ExecutedSuite } from "./evidence.js";
import { selectTests, type AvailableSuite } from "./selection.js";

const available: AvailableSuite[] = [
  { key: "smoke", kind: "SMOKE" },
  { key: "regression", kind: "REGRESSION" },
  { key: "api", kind: "API" }
];

describe("risk-driven test selection", () => {
  it("runs only smoke suites for low risk", () => {
    const selection = selectTests("LOW", available);
    expect(selection.strategy).toBe("SMOKE");
    expect(selection.suiteKeys).toEqual(["smoke"]);
  });

  it("runs regression and API suites for high and critical risk", () => {
    expect(selectTests("HIGH", available).suiteKeys).toEqual(["smoke", "regression", "api"]);
    expect(selectTests("CRITICAL", available).strategy).toBe("FULL_REGRESSION_AND_API");
  });

  it("runs every allow-listed suite when none matches the preferred kinds", () => {
    const selection = selectTests("LOW", [
      { key: "unit", kind: "REGRESSION" },
      { key: "contract", kind: "API" }
    ]);

    expect(selection.suiteKeys).toEqual(["unit", "contract"]);
    expect(selection.reason).toContain("every allow-listed suite ran instead");
  });

  it("reports that no evidence is possible when nothing is allow-listed", () => {
    const empty = selectTests("LOW", []);
    expect(empty.suiteKeys).toEqual([]);
    expect(empty.reason).toContain("no test evidence will be produced");
  });
});

describe("evidence derived from execution", () => {
  const executions: ExecutedSuite[] = [
    {
      kind: "SMOKE",
      results: [
        { status: "PASSED", critical: true, retries: 0 },
        { status: "FAILED", critical: true, retries: 0 },
        { status: "FLAKY", critical: false, retries: 1 },
        { status: "SKIPPED", critical: false, retries: 0 }
      ]
    },
    {
      kind: "API",
      results: [
        { status: "PASSED", critical: false, retries: 0 },
        { status: "TIMED_OUT", critical: false, retries: 0 }
      ]
    }
  ];

  it("counts regression, API and flakiness from what actually ran", () => {
    const evidence = buildQualityEvidence(executions, {});

    expect(evidence.regression).toEqual({ passed: 2, failed: 1, criticalFailures: 1 });
    expect(evidence.api).toEqual({ passed: 1, failed: 1 });
    expect(evidence.flakyRate).toBeCloseTo(20, 5);
  });

  it("keeps coverage and mutation absent when nothing supplied them", () => {
    const evidence = buildQualityEvidence(executions, {});
    expect(evidence.coverage).toBeUndefined();
    expect(evidence.mutationScore).toBeUndefined();
  });

  it("reports no regression evidence when nothing executed", () => {
    const evidence = buildQualityEvidence([], { coverage: 80 });
    expect(evidence.regression).toBeUndefined();
    expect(evidence.api).toBeUndefined();
    expect(evidence.flakyRate).toBeUndefined();
    expect(evidence.coverage).toBe(80);
  });
});
