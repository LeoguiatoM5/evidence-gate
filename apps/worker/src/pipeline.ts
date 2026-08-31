import type { AnalysisStatus, TestRunnerPort, WorkerStage } from "@evidence-gate/core";
import { WORKER_STAGES } from "@evidence-gate/core";
import type { WorkerAnalysisRepository } from "@evidence-gate/persistence-prisma";
import {
  DEFAULT_QUALITY_POLICY,
  buildQualityEvidence,
  calculateQualityScore,
  evaluateQualityGate,
  selectTests,
  type QualityPolicy
} from "@evidence-gate/quality-engine";
import { DEFAULT_RISK_POLICY, assessRisk, type RiskPolicy } from "@evidence-gate/risk-engine";

export class StageError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly failureStatus: Extract<AnalysisStatus, "FAILED" | "TIMED_OUT"> = "FAILED"
  ) {
    super(message);
    this.name = "StageError";
  }
}

export interface PipelineFailure {
  code: string;
  message: string;
  retryable: boolean;
  failureStatus: Extract<AnalysisStatus, "FAILED" | "TIMED_OUT">;
}

export interface PipelineOutcome {
  status: Extract<AnalysisStatus, "COMPLETED" | "CANCELLED" | "FAILED" | "TIMED_OUT">;
  failure: PipelineFailure | null;
  stagesExecuted: WorkerStage[];
}

export interface AnalysisPipelineOptions {
  repository: WorkerAnalysisRepository;
  runner: TestRunnerPort;
  riskPolicy?: RiskPolicy;
  qualityPolicy?: QualityPolicy;
}

export interface PipelineRunOptions {
  /** Checked between stages so a cancellation never interrupts a partial write. */
  isCancellationRequested?: () => Promise<boolean>;
}

/**
 * Idempotent state machine:
 * PENDING -> ANALYZING -> SELECTING_TESTS -> EXECUTING -> CALCULATING -> COMPLETED
 * with FAILED, CANCELLED and TIMED_OUT as terminal outcomes. Every stage records its
 * own status, so a resumed job skips the work that already succeeded.
 */
export class AnalysisPipeline {
  private readonly repository: WorkerAnalysisRepository;
  private readonly runner: TestRunnerPort;
  private readonly riskPolicy: RiskPolicy;
  private readonly qualityPolicy: QualityPolicy;

  public constructor(options: AnalysisPipelineOptions) {
    this.repository = options.repository;
    this.runner = options.runner;
    this.riskPolicy = options.riskPolicy ?? DEFAULT_RISK_POLICY;
    this.qualityPolicy = options.qualityPolicy ?? DEFAULT_QUALITY_POLICY;
  }

  public async run(analysisId: string, options: PipelineRunOptions = {}): Promise<PipelineOutcome> {
    const stagesExecuted: WorkerStage[] = [];
    const isCancelled = options.isCancellationRequested ?? (async () => false);

    for (const stage of WORKER_STAGES) {
      if (await isCancelled()) {
        return { status: "CANCELLED", failure: null, stagesExecuted };
      }
      if (await this.repository.isStageCompleted(analysisId, stage)) continue;

      await this.repository.setStatus(analysisId, stage);
      await this.repository.beginStage(analysisId, stage);

      try {
        await this.runStage(stage, analysisId);
      } catch (error) {
        const failure = this.toFailure(error);
        await this.repository.failStage(analysisId, stage, failure.code);
        return { status: failure.failureStatus, failure, stagesExecuted };
      }

      await this.repository.completeStage(analysisId, stage);
      stagesExecuted.push(stage);
    }

    await this.repository.setStatus(analysisId, "COMPLETED");
    return { status: "COMPLETED", failure: null, stagesExecuted };
  }

  private async runStage(stage: WorkerStage, analysisId: string): Promise<void> {
    switch (stage) {
      case "ANALYZING":
        return this.analyze(analysisId);
      case "SELECTING_TESTS":
        return this.selectTests(analysisId);
      case "EXECUTING":
        return this.execute(analysisId);
      case "CALCULATING":
        return this.calculate(analysisId);
    }
  }

  private async analyze(analysisId: string): Promise<void> {
    const context = await this.repository.loadContext(analysisId);
    if (!context) {
      throw new StageError("ANALYSIS_NOT_FOUND", `Analysis ${analysisId} no longer exists.`, false);
    }
    if (context.changes.length === 0) {
      throw new StageError(
        "NO_CHANGES_PERSISTED",
        "The analysis has no persisted changes to assess.",
        false
      );
    }

    const risk = assessRisk(
      {
        changedFiles: context.changes.length,
        changedLines: context.totalChangedLines,
        inferredBusinessCriticality: Math.max(
          ...context.changes.map((change) => change.businessCriticality)
        ),
        metrics: context.riskMetrics
      },
      this.riskPolicy
    );
    await this.repository.saveRiskAssessment(analysisId, risk);
  }

  private async selectTests(analysisId: string): Promise<void> {
    const risk = await this.repository.loadRiskAssessment(analysisId);
    if (!risk) {
      throw new StageError(
        "RISK_ASSESSMENT_MISSING",
        "Test selection requires a persisted risk assessment.",
        true
      );
    }
    const selection = selectTests(risk.level, this.runner.listAllowedSuites());
    await this.repository.saveTestSelection(analysisId, risk.level, selection);
  }

  private async execute(analysisId: string): Promise<void> {
    const selection = await this.repository.loadTestSelection(analysisId);
    if (!selection) {
      throw new StageError(
        "TEST_SELECTION_MISSING",
        "Execution requires a persisted test selection.",
        true
      );
    }

    let timedOut = false;
    const failures: string[] = [];

    for (const suiteKey of selection.suiteKeys) {
      const report = await this.runner.run({ analysisId, suiteKey });
      await this.repository.saveExecution(analysisId, report);
      if (report.status === "TIMED_OUT") {
        timedOut = true;
        failures.push(`${suiteKey}: execution timed out`);
      } else if (report.status === "FAILED") {
        failures.push(`${suiteKey}: ${report.errorMessage ?? "execution failed"}`);
      }
    }

    if (failures.length > 0) {
      throw new StageError(
        timedOut ? "EXECUTION_TIMED_OUT" : "EXECUTION_FAILED",
        `The suite execution did not produce usable evidence. ${failures.join(" | ")}`,
        true,
        timedOut ? "TIMED_OUT" : "FAILED"
      );
    }
  }

  private async calculate(analysisId: string): Promise<void> {
    const context = await this.repository.loadContext(analysisId);
    const risk = await this.repository.loadRiskAssessment(analysisId);
    if (!context || !risk) {
      throw new StageError(
        "RISK_ASSESSMENT_MISSING",
        "The quality calculation requires the persisted context and risk assessment.",
        true
      );
    }

    const executions = await this.repository.loadExecutionReports(analysisId);
    const evidence = buildQualityEvidence(executions, context.suppliedEvidence);
    const quality = calculateQualityScore(risk, evidence, this.qualityPolicy);
    const gate = evaluateQualityGate(risk, quality, evidence, this.qualityPolicy);
    await this.repository.saveQuality(analysisId, quality, gate);
  }

  private toFailure(error: unknown): PipelineFailure {
    if (error instanceof StageError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        failureStatus: error.failureStatus
      };
    }
    return {
      code: "STAGE_UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "Unknown stage error.",
      retryable: true,
      failureStatus: "FAILED"
    };
  }
}
