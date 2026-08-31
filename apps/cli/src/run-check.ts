import type {
  QualityGateResult,
  QualityScoreResult,
  RepositoryAnalysis,
  RiskAssessment,
  TestExecutionReport,
  TestRunnerPort,
  TestSelection
} from "@evidence-gate/core";
import { analyzeGitDiff } from "@evidence-gate/git-analyzer";
import type { QualityEvidence } from "@evidence-gate/quality-engine";
import { calculateQualityScore, evaluateQualityGate } from "@evidence-gate/quality-engine";
import { assessRisk } from "@evidence-gate/risk-engine";
import { SubprocessTestRunner } from "@evidence-gate/test-runner";
import type { CheckConfig } from "./config.js";
import { describePolicyVersion } from "./policy-overrides.js";
import { buildEvidence, selectSuites } from "./selection.js";

export interface CheckResult {
  projectName: string;
  diffSource: string;
  policyVersion: string;
  generatedAt: string;
  repositoryAnalysis: RepositoryAnalysis;
  risk: RiskAssessment;
  selection: TestSelection;
  executions: TestExecutionReport[];
  evidence: QualityEvidence;
  quality: QualityScoreResult;
  gate: QualityGateResult;
  /** True when a suite crashed or timed out; the decision then cannot be trusted. */
  executionBroken: boolean;
}

export class CheckError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CheckError";
  }
}

export interface RunCheckOptions {
  config: CheckConfig;
  diff: string;
  diffSource: string;
  runner?: TestRunnerPort;
  onStage?: (stage: string, detail: string) => void;
}

/**
 * The same pipeline the worker runs, executed in one process and without a database:
 * analyse, assess risk, select suites, execute them, score, decide.
 */
export const runCheck = async (options: RunCheckOptions): Promise<CheckResult> => {
  const { config } = options;
  const notify = options.onStage ?? (() => undefined);

  notify("ANALYZING", "reading the diff");
  const repositoryAnalysis = analyzeGitDiff(options.diff, config.criticalityRules);

  const risk = assessRisk(
    {
      changedFiles: repositoryAnalysis.changes.length,
      changedLines: repositoryAnalysis.totalChangedLines,
      inferredBusinessCriticality: Math.max(
        ...repositoryAnalysis.changes.map((change) => change.businessCriticality)
      ),
      metrics: config.riskMetrics
    },
    config.policies.risk
  );
  notify("ANALYZING", `risk ${String(risk.score)} (${risk.level})`);

  const runner = options.runner ?? new SubprocessTestRunner({ policy: config.policy });
  const selection = selectSuites(risk.level, runner.listAllowedSuites());
  notify(
    "SELECTING_TESTS",
    selection.suiteKeys.length === 0
      ? "no suite matches the strategy"
      : selection.suiteKeys.join(", ")
  );

  const executions: TestExecutionReport[] = [];
  for (const suiteKey of selection.suiteKeys) {
    notify("EXECUTING", suiteKey);
    executions.push(await runner.run({ analysisId: "cli", suiteKey }));
  }

  const executionBroken = executions.some((execution) => execution.status !== "COMPLETED");
  const evidence = buildEvidence(executions, config.suppliedEvidence);
  const quality = calculateQualityScore(risk, evidence, config.policies.quality);
  const gate = evaluateQualityGate(risk, quality, evidence, config.policies.quality);
  notify("CALCULATING", `score ${String(quality.score)} → ${gate.decision}`);

  return {
    projectName: config.projectName,
    diffSource: options.diffSource,
    policyVersion: describePolicyVersion(config.policies),
    generatedAt: new Date().toISOString(),
    repositoryAnalysis,
    risk,
    selection,
    executions,
    evidence,
    quality,
    gate,
    executionBroken
  };
};
