-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'LOCAL',
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseSha" TEXT,
    "headSha" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "diffHash" TEXT NOT NULL,
    "affectedAreas" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Analysis_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "errorCode" TEXT,
    CONSTRAINT "AnalysisStage_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GitChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "oldPath" TEXT,
    "type" TEXT NOT NULL,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "extension" TEXT,
    "area" TEXT NOT NULL,
    "businessCriticality" REAL NOT NULL,
    CONSTRAINT "GitChange_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "factors" JSONB NOT NULL,
    "missingEvidence" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiskAssessment_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "confidence" REAL NOT NULL,
    "components" JSONB NOT NULL,
    "missingEvidence" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QualityScore_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityGate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "evaluatedRules" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QualityGate_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_projectId_name_key" ON "Repository"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Analysis_idempotencyKey_key" ON "Analysis"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Analysis_repositoryId_headSha_idx" ON "Analysis"("repositoryId", "headSha");

-- CreateIndex
CREATE INDEX "Analysis_status_createdAt_idx" ON "Analysis"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisStage_analysisId_name_key" ON "AnalysisStage"("analysisId", "name");

-- CreateIndex
CREATE INDEX "GitChange_analysisId_area_idx" ON "GitChange"("analysisId", "area");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessment_analysisId_key" ON "RiskAssessment"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "QualityScore_analysisId_key" ON "QualityScore"("analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "QualityGate_analysisId_key" ON "QualityGate"("analysisId");
