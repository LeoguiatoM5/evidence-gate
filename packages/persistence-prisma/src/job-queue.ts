import type { JobStatus } from "@qualityguard/core";
import type { PrismaClient } from "./generated/prisma/client";

/**
 * Minimal lease-based queue on top of SQLite. It is intentionally single-worker
 * friendly: leases are taken with a conditional update, so a second worker never
 * steals a running job, and an expired lease returns the job to the queue.
 */

export interface LeasedJob {
  id: string;
  analysisId: string;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
  backoffMs?: number;
}

export interface JobFailureOutcome {
  status: Extract<JobStatus, "QUEUED" | "FAILED">;
  attempts: number;
  retrying: boolean;
}

const DEFAULT_BACKOFF_MS = 5_000;
const LEASE_CANDIDATES = 5;
const RECLAIM_BATCH = 20;

export class JobQueue {
  public constructor(private readonly prisma: PrismaClient) {}

  /** Creates the queue row for an analysis. Repeated calls return the existing job. */
  public async enqueue(analysisId: string, maxAttempts = 3): Promise<LeasedJob> {
    const job = await this.prisma.analysisJob.upsert({
      where: { analysisId },
      update: {},
      create: { analysisId, status: "QUEUED", maxAttempts }
    });
    return this.toLeasedJob(job);
  }

  /**
   * Returns jobs whose worker died to the queue. Jobs that already used every
   * attempt are failed instead of looping forever.
   */
  public async reclaimExpiredLeases(now = new Date()): Promise<number> {
    const expired = await this.prisma.analysisJob.findMany({
      where: { status: "RUNNING", leaseExpiresAt: { lt: now } },
      take: RECLAIM_BATCH
    });

    let reclaimed = 0;
    for (const job of expired) {
      const exhausted = job.attempts >= job.maxAttempts;
      const updated = await this.prisma.analysisJob.updateMany({
        where: { id: job.id, status: "RUNNING", leaseExpiresAt: { lt: now } },
        data: exhausted
          ? {
              status: "FAILED",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: "LEASE_EXPIRED",
              lastErrorMessage: "The worker lease expired after the last allowed attempt."
            }
          : {
              status: "QUEUED",
              leaseOwner: null,
              leaseExpiresAt: null,
              availableAt: now,
              lastErrorCode: "LEASE_EXPIRED",
              lastErrorMessage: "The worker lease expired and the job returned to the queue."
            }
      });
      reclaimed += updated.count;
    }
    return reclaimed;
  }

  public async leaseNext(
    owner: string,
    leaseMs: number,
    now = new Date()
  ): Promise<LeasedJob | null> {
    await this.reclaimExpiredLeases(now);

    const candidates = await this.prisma.analysisJob.findMany({
      where: { status: "QUEUED", availableAt: { lte: now } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      take: LEASE_CANDIDATES
    });

    for (const candidate of candidates) {
      const leased = await this.prisma.analysisJob.updateMany({
        where: { id: candidate.id, status: "QUEUED" },
        data: {
          status: "RUNNING",
          leaseOwner: owner,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 }
        }
      });
      if (leased.count !== 1) continue;

      const job = await this.prisma.analysisJob.findUnique({ where: { id: candidate.id } });
      if (job) return this.toLeasedJob(job);
    }

    return null;
  }

  /** Extends a lease held by `owner`. Returns false when the lease was lost. */
  public async heartbeat(jobId: string, owner: string, leaseMs: number): Promise<boolean> {
    const updated = await this.prisma.analysisJob.updateMany({
      where: { id: jobId, status: "RUNNING", leaseOwner: owner },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) }
    });
    return updated.count === 1;
  }

  public async succeed(jobId: string): Promise<void> {
    await this.prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        status: "SUCCEEDED",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });
  }

  public async fail(jobId: string, failure: JobFailure): Promise<JobFailureOutcome> {
    const job = await this.prisma.analysisJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job ${jobId} no longer exists.`);

    const retrying = failure.retryable && job.attempts < job.maxAttempts;
    await this.prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        status: retrying ? "QUEUED" : "FAILED",
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: retrying
          ? new Date(Date.now() + (failure.backoffMs ?? DEFAULT_BACKOFF_MS))
          : job.availableAt,
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message
      }
    });

    return { status: retrying ? "QUEUED" : "FAILED", attempts: job.attempts, retrying };
  }

  public async markCancelled(jobId: string): Promise<void> {
    await this.prisma.analysisJob.update({
      where: { id: jobId },
      data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null }
    });
  }

  /**
   * Cancels a queued job immediately; a running job is flagged so the worker stops
   * between stages instead of being killed mid-write.
   */
  public async requestCancellation(
    analysisId: string
  ): Promise<{ accepted: boolean; status: JobStatus | null }> {
    const job = await this.prisma.analysisJob.findUnique({ where: { analysisId } });
    if (!job) return { accepted: false, status: null };

    if (job.status === "QUEUED") {
      await this.prisma.analysisJob.update({
        where: { id: job.id },
        data: { status: "CANCELLED", cancelRequested: true }
      });
      return { accepted: true, status: "CANCELLED" };
    }
    if (job.status === "RUNNING") {
      await this.prisma.analysisJob.update({
        where: { id: job.id },
        data: { cancelRequested: true }
      });
      return { accepted: true, status: "RUNNING" };
    }
    return { accepted: false, status: job.status as JobStatus };
  }

  public async isCancellationRequested(jobId: string): Promise<boolean> {
    const job = await this.prisma.analysisJob.findUnique({
      where: { id: jobId },
      select: { cancelRequested: true }
    });
    return job?.cancelRequested ?? false;
  }

  public async findByAnalysisId(analysisId: string): Promise<LeasedJob | null> {
    const job = await this.prisma.analysisJob.findUnique({ where: { analysisId } });
    return job ? this.toLeasedJob(job) : null;
  }

  private toLeasedJob(job: {
    id: string;
    analysisId: string;
    attempts: number;
    maxAttempts: number;
    cancelRequested: boolean;
  }): LeasedJob {
    return {
      id: job.id,
      analysisId: job.analysisId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      cancelRequested: job.cancelRequested
    };
  }
}
