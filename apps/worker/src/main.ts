import "dotenv/config";
import {
  JobQueue,
  WorkerAnalysisRepository,
  createPrismaClient
} from "@qualityguard/persistence-prisma";
import { SubprocessTestRunner } from "@qualityguard/test-runner";
import { loadWorkerConfig } from "./config.js";
import { AnalysisPipeline } from "./pipeline.js";
import { AnalysisWorker, type WorkerLogger } from "./worker.js";

const logger: WorkerLogger = {
  info: (payload, message) => {
    console.log(JSON.stringify({ level: "info", message, ...payload }));
  },
  warn: (payload, message) => {
    console.warn(JSON.stringify({ level: "warn", message, ...payload }));
  }
};

const config = loadWorkerConfig();
const prisma = createPrismaClient();
const repository = new WorkerAnalysisRepository(prisma);
const queue = new JobQueue(prisma);
const runner = new SubprocessTestRunner({ policy: config.policy, validatePolicy: false });
const pipeline = new AnalysisPipeline({ repository, runner });
const worker = new AnalysisWorker({
  queue,
  repository,
  pipeline,
  owner: config.owner,
  leaseMs: config.leaseMs,
  pollIntervalMs: config.pollIntervalMs,
  retryBackoffMs: config.retryBackoffMs,
  logger
});

logger.info(
  {
    owner: config.owner,
    suites: runner.listAllowedSuites().map((suite) => suite.key),
    artifactsRoot: config.policy.artifactsRoot
  },
  "QualityGuard worker started."
);
worker.start();

const shutdown = (signal: string): void => {
  logger.info({ signal }, "Stopping the QualityGuard worker.");
  void worker
    .stop()
    .then(() => prisma.$disconnect())
    .then(() => {
      process.exitCode = 0;
    });
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
