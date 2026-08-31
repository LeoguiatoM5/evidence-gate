import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionPolicyError } from "./policy.js";
import { StrykerMutationRunner, assertMutationPolicy, type MutationPolicy } from "./mutation.js";
import { parseStrykerReport } from "./report-stryker.js";
import { TestReportError } from "./report.js";

const testRoot = resolve(process.cwd(), ".tmp", "mutation-runner", randomUUID());
const projectRoot = resolve(testRoot, "project");
const artifactsRoot = resolve(testRoot, "artifacts");

/** A report in the mutation-testing schema, the format StrykerJS emits. */
const strykerReport = {
  schemaVersion: "1.0",
  thresholds: { high: 80, low: 60 },
  files: {
    "packages/quality-engine/src/index.ts": {
      language: "typescript",
      mutants: [
        { id: "1", mutatorName: "ConditionalExpression", status: "Killed", location: { start: { line: 10 } } },
        { id: "2", mutatorName: "ArithmeticOperator", status: "Survived", location: { start: { line: 42 } } },
        { id: "3", mutatorName: "BooleanLiteral", status: "Timeout", location: { start: { line: 51 } } }
      ]
    },
    "./apps/cli/src/main.ts": {
      language: "typescript",
      mutants: [
        { id: "4", mutatorName: "StringLiteral", status: "Killed", location: { start: { line: 7 } } },
        { id: "5", mutatorName: "EqualityOperator", status: "Survived", location: { start: { line: 9 } } },
        { id: "6", mutatorName: "BlockStatement", status: "NoCoverage", location: { start: { line: 12 } } },
        { id: "7", mutatorName: "ObjectLiteral", status: "CompileError", location: { start: { line: 20 } } },
        { id: "8", mutatorName: "Ignored", status: "Ignored", location: { start: { line: 21 } } }
      ]
    }
  }
};

const criticalPathPrefixes = ["packages/quality-engine/"];

const writeScript = (name: string, source: string): string => {
  const path = resolve(projectRoot, name);
  writeFileSync(path, source, "utf8");
  return path;
};

const runnerScript = `
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const report = ${JSON.stringify(strykerReport)};
mkdirSync(dirname("reports/mutation.json"), { recursive: true });
writeFileSync("reports/mutation.json", JSON.stringify(report), "utf8");
console.log("mutation run finished with token ghp_0123456789abcdefghij");
process.exit(0);
`;

const crashingScript = `
console.error("stryker crashed before writing a report");
process.exit(1);
`;

const hangingScript = `setInterval(() => {}, 1000);`;

let policy: MutationPolicy;

beforeAll(() => {
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  policy = {
    workingDirectory: projectRoot,
    artifactsRoot,
    command: process.execPath,
    args: [writeScript("runner.cjs", runnerScript)],
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    reportPath: "reports/mutation.json"
  };
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("Stryker report parsing", () => {
  it("computes the mutation score as detected over valid mutants", () => {
    const report = parseStrykerReport(strykerReport, { criticalPathPrefixes });

    // killed 2 + timeout 1 = 3 detected; survived 2 + noCoverage 1 = 3 undetected.
    // compileError and ignored are excluded from both sides.
    expect(report.totals).toEqual({
      killed: 2,
      survived: 2,
      timeout: 1,
      noCoverage: 1,
      compileError: 1,
      runtimeError: 0,
      ignored: 1
    });
    expect(report.mutationScore).toBe(50);
    expect(report.filesAnalysed).toBe(2);
  });

  it("counts only survivors in a critical area, not uncovered mutants", () => {
    const report = parseStrykerReport(strykerReport, { criticalPathPrefixes });

    expect(report.survivedCriticalMutants).toBe(1);
    const critical = report.survivors.filter((survivor) => survivor.critical);
    expect(critical).toHaveLength(1);
    expect(critical[0]?.file).toBe("packages/quality-engine/src/index.ts");
    expect(critical[0]?.line).toBe(42);
  });

  it("normalises a leading ./ so a path prefix still matches", () => {
    const report = parseStrykerReport(strykerReport, {
      criticalPathPrefixes: ["apps/cli/"]
    });

    expect(report.survivedCriticalMutants).toBe(1);
    expect(report.survivors.some((survivor) => survivor.file === "apps/cli/src/main.ts")).toBe(true);
  });

  it("returns a zero score when there is no valid mutant", () => {
    const report = parseStrykerReport(
      { files: { "a.ts": { mutants: [{ id: "1", status: "CompileError" }] } } },
      { criticalPathPrefixes: [] }
    );
    expect(report.mutationScore).toBe(0);
  });

  it("rejects a report that is not in the expected shape", () => {
    expect(() => parseStrykerReport({ nope: true }, { criticalPathPrefixes: [] })).toThrow(
      TestReportError
    );
    expect(() => parseStrykerReport("not json", { criticalPathPrefixes: [] })).toThrow(
      TestReportError
    );
  });
});

describe("mutation policy", () => {
  it("rejects a relative command", () => {
    expect(() => assertMutationPolicy({ ...policy, command: "stryker" })).toThrow(
      ExecutionPolicyError
    );
  });

  it("rejects a report path that escapes the working directory", () => {
    expect(() =>
      assertMutationPolicy({ ...policy, reportPath: "../../etc/report.json" })
    ).toThrow(ExecutionPolicyError);
  });
});

describe("mutation execution", () => {
  it("runs the allow-listed command and normalises the report it produced", async () => {
    const runner = new StrykerMutationRunner(policy);
    const report = await runner.run({ analysisId: "run-ok", criticalPathPrefixes });

    expect(report.status).toBe("COMPLETED");
    expect(report.exitCode).toBe(0);
    expect(report.mutation?.mutationScore).toBe(50);
    expect(report.mutation?.survivedCriticalMutants).toBe(1);
    expect(report.artifacts.map((artifact) => artifact.type)).toContain("MUTATION_REPORT");

    const output = report.artifacts.find((artifact) => artifact.type === "PROCESS_OUTPUT");
    const captured = readFileSync(resolve(artifactsRoot, output?.path ?? ""), "utf8");
    expect(captured).toContain("mutation run finished");
    expect(captured).not.toContain("ghp_0123456789abcdefghij");
  }, 30_000);

  it("reports a crashed run as FAILED with no mutation evidence", async () => {
    const runner = new StrykerMutationRunner({
      ...policy,
      args: [writeScript("crashing.cjs", crashingScript)],
      reportPath: "reports/absent.json"
    });
    const report = await runner.run({ analysisId: "run-crash", criticalPathPrefixes });

    expect(report.status).toBe("FAILED");
    expect(report.mutation).toBeNull();
    expect(report.errorMessage).toContain("without producing a report");
  }, 30_000);

  it("kills a mutation run that exceeds the timeout", async () => {
    const runner = new StrykerMutationRunner({
      ...policy,
      args: [writeScript("hanging.cjs", hangingScript)],
      timeoutMs: 1200
    });
    const report = await runner.run({ analysisId: "run-timeout", criticalPathPrefixes });

    expect(report.status).toBe("TIMED_OUT");
    expect(report.timedOut).toBe(true);
    expect(report.mutation).toBeNull();
  }, 30_000);
});
