import type {
  MutationExecutionReport,
  QualityGateResult,
  QualityScoreResult,
  RepositoryAnalysis,
  RiskAssessment,
  TestExecutionReport,
  TestRunnerPort,
  TestSelection
} from "@evidence-gate/core";
import { analyzeGitDiff } from "@evidence-gate/git-analyzer";
import type { DerivedMetricsResult } from "@evidence-gate/git-history";
import { deriveRiskMetrics, discoverTestFiles } from "@evidence-gate/git-history";
import type { QualityEvidence } from "@evidence-gate/quality-engine";
import { calculateQualityScore, evaluateQualityGate } from "@evidence-gate/quality-engine";
import { assessRisk } from "@evidence-gate/risk-engine";
import { StrykerMutationRunner, SubprocessTestRunner } from "@evidence-gate/test-runner";
import type { MutationRunnerPort, RiskLevel } from "@evidence-gate/core";
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
  /** What the repository history could tell us, and what it could not. */
  history: DerivedMetricsResult | null;
  /** Null when the project declared no mutation run, or the risk did not require one. */
  mutation: MutationExecutionReport | null;
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
  mutationRunner?: MutationRunnerPort;
  /** Forces the mutation run on or off, whatever the configured risk levels are. */
  mutation?: boolean;
  /** Skips reading the repository history. */
  history?: boolean;
  /** Test files considered when counting related tests. */
  testFiles?: readonly string[];
  onStage?: (stage: string, detail: string) => void;
}

/**
 * The same pipeline the worker runs, executed in one process and without a database:
 * analyse, assess risk, select suites, execute them, score, decide.
 */
const runMutation = async (
  options: RunCheckOptions,
  riskLevel: RiskLevel,
  notify: (stage: string, detail: string) => void
): Promise<MutationExecutionReport | null> => {
  const settings = options.config.mutation;
  if (!settings) return null;

  const required = settings.runOn.includes(riskLevel);
  const shouldRun = options.mutation ?? required;
  if (!shouldRun) {
    notify(
      "MUTATION",
      options.mutation === false
        ? "skipped — disabled with --no-mutation"
        : `skipped — ${riskLevel} risk is not in ${settings.runOn.join(", ")}`
    );
    return null;
  }

  notify("MUTATION", "running mutation testing");
  const runner =
    options.mutationRunner ?? new StrykerMutationRunner(settings.policy, { validate: false });
  const report = await runner.run({
    analysisId: "cli",
    criticalPathPrefixes: settings.criticalPathPrefixes
  });
  notify(
    "MUTATION",
    report.mutation
      ? `score ${String(report.mutation.mutationScore)} · ${String(report.mutation.survivedCriticalMutants)} critical survivor(s)`
      : `${report.status.toLowerCase()} — no mutation evidence`
  );
  return report;
};

export const runCheck = async (options: RunCheckOptions): Promise<CheckResult> => {
  const { config } = options;
  const notify = options.onStage ?? (() => undefined);

  notify("ANALYZING", "reading the diff");
  const repositoryAnalysis = analyzeGitDiff(options.diff, config.criticalityRules);

  // Counted beats declared: a metric read from the history replaces the value the
  // configuration guessed. What the history cannot count stays as configured.
  let history: DerivedMetricsResult | null = null;
  if (options.history !== false) {
    history = deriveRiskMetrics({
      cwd: config.policy.workingDirectory,
      changedPaths: repositoryAnalysis.changes.map((change) => change.path),
      testFiles: options.testFiles ?? discoverTestFiles(config.policy.workingDirectory)
    });
    notify(
      "ANALYZING",
      history.commitsAnalysed === 0
        ? "no history available"
        : `${String(history.commitsAnalysed)} commits in the last ${String(history.windowDays)} days`
    );
  }
  const riskMetrics = { ...config.riskMetrics, ...(history?.metrics ?? {}) };

  const risk = assessRisk(
    {
      changedFiles: repositoryAnalysis.changes.length,
      changedLines: repositoryAnalysis.totalChangedLines,
      inferredBusinessCriticality: Math.max(
        ...repositoryAnalysis.changes.map((change) => change.businessCriticality)
      ),
      metrics: riskMetrics
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

  const mutation = await runMutation(options, risk.level, notify);
  const supplied = { ...config.suppliedEvidence };
  if (mutation) {
    // Executed evidence always wins, and a failed measurement is not papered over
    // with the value the project declared: it becomes missing evidence instead.
    delete supplied.mutationScore;
    delete supplied.survivedCriticalMutants;
    if (mutation.mutation) {
      supplied.mutationScore = mutation.mutation.mutationScore;
      supplied.survivedCriticalMutants = mutation.mutation.survivedCriticalMutants;
    }
  }
  const evidence = buildEvidence(executions, supplied);
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
    history,
    mutation,
    quality,
    gate,
    executionBroken
  };
};
