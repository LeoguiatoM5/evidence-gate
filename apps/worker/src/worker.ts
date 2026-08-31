import type { AnalysisStatus } from "@evidence-gate/core";
import type { JobQueue, WorkerAnalysisRepository } from "@evidence-gate/persistence-prisma";
import type { AnalysisPipeline } from "./pipeline.js";

export interface WorkerLogger {
  info: (payload: Record<string, unknown>, message: string) => void;
  warn: (payload: Record<string, unknown>, message: string) => void;
}

const silentLogger: WorkerLogger = { info: () => undefined, warn: () => undefined };

export interface AnalysisWorkerOptions {
  queue: JobQueue;
  repository: WorkerAnalysisRepository;
  pipeline: AnalysisPipeline;
  owner: string;
  leaseMs: number;
  pollIntervalMs: number;
  retryBackoffMs?: number;
  logger?: WorkerLogger;
}

export interface WorkerTick {
  processed: boolean;
  analysisId: string | null;
  status: AnalysisStatus | null;
  requeued: boolean;
}

const IDLE_TICK: WorkerTick = {
  processed: false,
  analysisId: null,
  status: null,
  requeued: false
};

/**
 * Leases one job at a time and drives it through the pipeline. A lost lease, a crash
 * or a restart leaves the job recoverable: the lease expires and the analysis resumes
 * from the first stage that has not completed.
 */
export class AnalysisWorker {
  private readonly options: AnalysisWorkerOptions;
  private readonly logger: WorkerLogger;
  private running = false;
  private loop: Promise<void> | null = null;

  public constructor(options: AnalysisWorkerOptions) {
    this.options = options;
    this.logger = options.logger ?? silentLogger;
  }

  public async runOnce(): Promise<WorkerTick> {
    const { queue, repository, pipeline, owner, leaseMs } = this.options;
    const job = await queue.leaseNext(owner, leaseMs);
    if (!job) return IDLE_TICK;

    if (job.cancelRequested) {
      await repository.setStatus(job.analysisId, "CANCELLED");
      await queue.markCancelled(job.id);
      return { processed: true, analysisId: job.analysisId, status: "CANCELLED", requeued: false };
    }

    const heartbeat = setInterval(() => {
      void queue.heartbeat(job.id, owner, leaseMs);
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref();

    try {
      const outcome = await pipeline.run(job.analysisId, {
        isCancellationRequested: () => queue.isCancellationRequested(job.id)
      });

      if (outcome.status === "COMPLETED") {
        await queue.succeed(job.id);
        this.logger.info({ analysisId: job.analysisId }, "Analysis completed.");
        return {
          processed: true,
          analysisId: job.analysisId,
          status: "COMPLETED",
          requeued: false
        };
      }

      if (outcome.status === "CANCELLED") {
        await repository.setStatus(job.analysisId, "CANCELLED");
        await queue.markCancelled(job.id);
        return {
          processed: true,
          analysisId: job.analysisId,
          status: "CANCELLED",
          requeued: false
        };
      }

      const failure = outcome.failure ?? {
        code: "UNKNOWN_FAILURE",
        message: "The pipeline failed without reporting a reason.",
        retryable: false,
        failureStatus: outcome.status
      };
      const result = await queue.fail(job.id, {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        backoffMs: this.options.retryBackoffMs
      });
      const status: AnalysisStatus = result.retrying ? "PENDING" : failure.failureStatus;
      await repository.setStatus(job.analysisId, status);
      this.logger.warn(
        { analysisId: job.analysisId, code: failure.code, retrying: result.retrying },
        failure.message
      );
      return {
        processed: true,
        analysisId: job.analysisId,
        status,
        requeued: result.retrying
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected worker error.";
      const result = await queue.fail(job.id, {
        code: "WORKER_UNEXPECTED_ERROR",
        message,
        retryable: true,
        backoffMs: this.options.retryBackoffMs
      });
      const status: AnalysisStatus = result.retrying ? "PENDING" : "FAILED";
      await repository.setStatus(job.analysisId, status);
      this.logger.warn({ analysisId: job.analysisId, code: "WORKER_UNEXPECTED_ERROR" }, message);
      return { processed: true, analysisId: job.analysisId, status, requeued: result.retrying };
    } finally {
      clearInterval(heartbeat);
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop;
    this.loop = null;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      let tick: WorkerTick = IDLE_TICK;
      try {
        tick = await this.runOnce();
      } catch (error) {
        this.logger.warn(
          { code: "WORKER_LOOP_ERROR" },
          error instanceof Error ? error.message : "Unexpected worker loop error."
        );
      }
      if (!tick.processed) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private sleep(durationMs: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, durationMs);
      timer.unref();
    });
  }
}
