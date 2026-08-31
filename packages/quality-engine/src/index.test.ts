import type { RiskAssessment } from "@qualityguard/core";
import { describe, expect, it } from "vitest";
import {
  calculateQualityScore,
  evaluateQualityGate,
  type QualityEvidence
} from "./index.js";

const risk = (score: number, level: RiskAssessment["level"] = "MEDIUM"): RiskAssessment => ({
  score,
  level,
  confidence: 100,
  factors: [],
  missingEvidence: []
});

const strongEvidence: QualityEvidence = {
  regression: { passed: 100, failed: 0, criticalFailures: 0 },
  mutationScore: 90,
  api: { passed: 20, failed: 0 },
  flakyRate: 0,
  coverage: 95,
  mitigationCoverage: 100,
  criticalSecurityIssues: 0,
  survivedCriticalMutants: 0
};

describe("Quality Engine", () => {
  it("approves a fully evidenced release that satisfies every gate", () => {
    const assessment = risk(70, "HIGH");
    const quality = calculateQualityScore(assessment, strongEvidence);
    const gate = evaluateQualityGate(assessment, quality, strongEvidence);

    expect(quality.score).toBeGreaterThanOrEqual(85);
    expect(quality.confidence).toBe(100);
    expect(gate.decision).toBe("RELEASE_APPROVED");
  });

  it("blocks a green suite when mutation score is below the threshold", () => {
    const assessment = risk(40);
    const evidence = { ...strongEvidence, mutationScore: 60 };
    const quality = calculateQualityScore(assessment, evidence);
    const gate = evaluateQualityGate(assessment, quality, evidence);

    expect(gate.decision).toBe("RELEASE_BLOCKED");
    expect(gate.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MUTATION_BELOW_THRESHOLD" })])
    );
  });

  it("never treats missing metrics as successful evidence", () => {
    const assessment = risk(20, "LOW");
    const evidence: QualityEvidence = {
      regression: { passed: 10, failed: 0, criticalFailures: 0 }
    };
    const quality = calculateQualityScore(assessment, evidence);
    const gate = evaluateQualityGate(assessment, quality, evidence);

    expect(quality.missingEvidence).toContain("mutation");
    expect(quality.components.find((component) => component.key === "mutation")?.score).toBe(0);
    expect(gate.decision).not.toBe("RELEASE_APPROVED");
  });

  it("blocks a critical test failure regardless of a high score", () => {
    const assessment = risk(20, "LOW");
    const evidence = {
      ...strongEvidence,
      regression: { passed: 1000, failed: 1, criticalFailures: 1 }
    };
    const quality = calculateQualityScore(assessment, evidence);
    const gate = evaluateQualityGate(assessment, quality, evidence);

    expect(gate.decision).toBe("RELEASE_BLOCKED");
    expect(gate.reasons[0]?.code).toBe("CRITICAL_TEST_FAILURE");
  });
});
