import type {
  RiskLevel,
  TestSelection,
  TestSelectionStrategy,
  TestSuiteKind
} from "@qualityguard/core";

export interface AvailableSuite {
  key: string;
  kind: TestSuiteKind;
}

interface StrategyDefinition {
  strategy: TestSelectionStrategy;
  kinds: TestSuiteKind[];
  description: string;
}

/**
 * Risk-driven selection over the allow-listed suites. Impact-based selection of
 * related suites depends on the test impact map, which does not exist yet, so the
 * reason recorded with the analysis states exactly what was and was not resolved.
 */
const STRATEGY_BY_RISK: Record<RiskLevel, StrategyDefinition> = {
  LOW: {
    strategy: "SMOKE",
    kinds: ["SMOKE"],
    description: "LOW risk runs the smoke suites."
  },
  MEDIUM: {
    strategy: "SMOKE_AND_RELATED",
    kinds: ["SMOKE"],
    description:
      "MEDIUM risk runs the smoke suites; related-suite selection requires the test impact map, which is not available yet."
  },
  HIGH: {
    strategy: "PARTIAL_REGRESSION_AND_API",
    kinds: ["SMOKE", "REGRESSION", "API"],
    description:
      "HIGH risk runs regression and API suites; partial selection requires the test impact map, so every allow-listed suite of these kinds runs."
  },
  CRITICAL: {
    strategy: "FULL_REGRESSION_AND_API",
    kinds: ["SMOKE", "REGRESSION", "API"],
    description:
      "CRITICAL risk runs the full regression and API suites; mutation testing is not part of this increment."
  }
};

export const selectTests = (
  riskLevel: RiskLevel,
  available: readonly AvailableSuite[]
): TestSelection => {
  const definition = STRATEGY_BY_RISK[riskLevel];
  const preferred = available.filter((suite) => definition.kinds.includes(suite.kind));

  if (available.length === 0) {
    return {
      strategy: definition.strategy,
      suiteKeys: [],
      reason: `${definition.description} No suite is allow-listed, so no test evidence will be produced.`
    };
  }

  // Running fewer tests than the strategy asks for is the unsafe direction. When a
  // project declares no suite of the preferred kinds, everything allow-listed runs.
  if (preferred.length === 0) {
    return {
      strategy: definition.strategy,
      suiteKeys: available.map((suite) => suite.key),
      reason: `${definition.description} No suite of kind ${definition.kinds.join(" or ")} is declared, so every allow-listed suite ran instead.`
    };
  }

  return {
    strategy: definition.strategy,
    suiteKeys: preferred.map((suite) => suite.key),
    reason: definition.description
  };
};
