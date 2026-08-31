-- CreateTable
CREATE TABLE "AnalysisInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "riskMetrics" JSONB NOT NULL,
    "suppliedEvidence" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisInput_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AnalysisJob_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestSelection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "suiteKeys" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestSelection_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "suiteKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "runner" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "outputTruncated" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "TestExecution_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestSuite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    CONSTRAINT "TestSuite_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suiteId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "errorType" TEXT,
    "errorMessage" TEXT,
    CONSTRAINT "TestResult_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisInput_analysisId_key" ON "AnalysisInput"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisJob_analysisId_key" ON "AnalysisJob"("analysisId");

-- CreateIndex
CREATE INDEX "AnalysisJob_status_availableAt_idx" ON "AnalysisJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AnalysisJob_status_leaseExpiresAt_idx" ON "AnalysisJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TestSelection_analysisId_key" ON "TestSelection"("analysisId");

-- CreateIndex
CREATE INDEX "TestExecution_analysisId_status_idx" ON "TestExecution"("analysisId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TestExecution_analysisId_suiteKey_key" ON "TestExecution"("analysisId", "suiteKey");

-- CreateIndex
CREATE INDEX "TestSuite_executionId_idx" ON "TestSuite"("executionId");

-- CreateIndex
CREATE INDEX "TestResult_suiteId_idx" ON "TestResult"("suiteId");

-- CreateIndex
CREATE INDEX "TestResult_identity_idx" ON "TestResult"("identity");

-- CreateIndex
CREATE INDEX "Artifact_executionId_idx" ON "Artifact"("executionId");
