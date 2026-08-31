import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  TestExecutionReport,
  TestExecutionRequest,
  TestRunnerPort,
  TestSuiteKind
} from "@qualityguard/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCheckConfig } from "./config.js";
import { DiffSourceError, resolveDiff } from "./diff-source.js";
import { parseArguments } from "./main.js";
import { renderHtmlReport } from "./report-html.js";
import { renderTerminalReport } from "./report-terminal.js";
import { runCheck } from "./run-check.js";

const testRoot = resolve(process.cwd(), ".tmp", "cli-tests", randomUUID());

const diff = `diff --git a/src/payment/limit.ts b/src/payment/limit.ts
index 1111111..2222222 100644
--- a/src/payment/limit.ts
+++ b/src/payment/limit.ts
@@ -1 +1 @@
-export const limit = 10;
+export const limit = 20;
`;

const configFile = (overrides: Record<string, unknown> = {}): string => {
  const path = resolve(testRoot, `qualityguard.${randomUUID()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      project: "example",
      criticalityRules: [
        { pathPrefix: "src/payment/", area: "Payments", businessCriticality: 90 }
      ],
      riskMetrics: { bugCount: 0, coverage: 95, mutationScore: 90, relatedTests: 6 },
      suppliedEvidence: {
        coverage: 95,
        mutationScore: 90,
        mitigationCoverage: 100,
        criticalSecurityIssues: 0,
        survivedCriticalMutants: 0
      },
      execution: {
        workingDirectory: ".",
        artifactsRoot: "artifacts",
        suites: [
          {
            key: "unit",
            kind: "REGRESSION",
            command: "node",
            args: ["--version"],
            reportFormat: "vitest-json"
          }
        ]
      },
      ...overrides
    }),
    "utf8"
  );
  return path;
};

/** Deterministic runner so the CLI assertions are about the CLI, not about a suite. */
class StubRunner implements TestRunnerPort {
  public readonly name = "stub";

  public constructor(private readonly failing: boolean) {}

  public listAllowedSuites(): { key: string; kind: TestSuiteKind }[] {
    return [
      { key: "unit", kind: "REGRESSION" },
      { key: "contract", kind: "API" }
    ];
  }

  public run(request: TestExecutionRequest): Promise<TestExecutionReport> {
    const kind: TestSuiteKind = request.suiteKey === "contract" ? "API" : "REGRESSION";
    return Promise.resolve({
      suiteKey: request.suiteKey,
      kind,
      runner: "stub",
      status: "COMPLETED",
      exitCode: this.failing ? 1 : 0,
      durationMs: 12,
      timedOut: false,
      outputTruncated: false,
      errorMessage: null,
      suites: [
        {
          title: "tests/limit.test.ts",
          file: "tests/limit.test.ts",
          durationMs: 12,
          results: [
            {
              identity: "limit-1",
              title: "keeps the payment limit",
              status: this.failing && kind === "REGRESSION" ? "FAILED" : "PASSED",
              durationMs: 12,
              retries: 0,
              critical: true,
              errorType: this.failing && kind === "REGRESSION" ? "ERROR" : null,
              errorMessage:
                this.failing && kind === "REGRESSION" ? "expected 20 but received 10" : null
            }
          ]
        }
      ],
      artifacts: []
    });
  }
}

beforeAll(() => {
  mkdirSync(testRoot, { recursive: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("argument parsing", () => {
  it("defaults to the check command and to failing on review", () => {
    const parsed = parseArguments([]);
    expect(parsed.command).toBe("check");
    expect(parsed.failOn).toBe("review");
    expect(parsed.writeReport).toBe(true);
  });

  it("reads every supported flag", () => {
    const parsed = parseArguments([
      "check",
      "--diff-file",
      "changes.patch",
      "--fail-on",
      "blocked",
      "--no-report",
      "--json"
    ]);
    expect(parsed.diffFile).toBe("changes.patch");
    expect(parsed.failOn).toBe("blocked");
    expect(parsed.writeReport).toBe(false);
    expect(parsed.json).toBe(true);
  });

  it("rejects an unknown option and an invalid --fail-on value", () => {
    expect(() => parseArguments(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseArguments(["--fail-on", "always"])).toThrow(/--fail-on/);
  });
});

describe("diff source", () => {
  it("reads a patch file", () => {
    const path = resolve(testRoot, "changes.patch");
    writeFileSync(path, diff, "utf8");
    const resolved = resolveDiff({ cwd: testRoot, baseRef: "origin/main", diffFile: "changes.patch" });
    expect(resolved.diff).toContain("diff --git");
    expect(resolved.source).toContain("changes.patch");
  });

  it("fails clearly when the patch file is missing", () => {
    expect(() =>
      resolveDiff({ cwd: testRoot, baseRef: "origin/main", diffFile: "absent.patch" })
    ).toThrow(DiffSourceError);
  });
});

describe("configuration", () => {
  it("resolves the literal node command to the running binary", () => {
    const config = loadCheckConfig({ cwd: testRoot, configPath: configFile() });
    expect(config.policy.suites[0]?.command).toBe(process.execPath);
    expect(config.policy.suites[0]?.reportFormat).toBe("vitest-json");
  });

  it("rejects a configuration file that does not exist", () => {
    expect(() => loadCheckConfig({ cwd: testRoot, configPath: "missing.json" })).toThrow(
      /Configuration file not found/
    );
  });

  it("rejects a suite kind that is not supported", () => {
    const path = configFile({
      execution: {
        workingDirectory: ".",
        artifactsRoot: "artifacts",
        suites: [{ key: "unit", kind: "CHAOS", command: "node", args: [] }]
      }
    });
    expect(() => loadCheckConfig({ cwd: testRoot, configPath: path })).toThrow(/kind must be one of/);
  });
});

describe("check pipeline", () => {
  it("approves a change backed by passing tests and complete evidence", async () => {
    const config = loadCheckConfig({ cwd: testRoot, configPath: configFile() });
    const result = await runCheck({
      config,
      diff,
      diffSource: "test fixture",
      runner: new StubRunner(false)
    });

    expect(result.gate.decision).toBe("RELEASE_APPROVED");
    expect(result.evidence.regression).toEqual({ passed: 1, failed: 0, criticalFailures: 0 });
    expect(result.evidence.api).toEqual({ passed: 1, failed: 0 });
    expect(result.executionBroken).toBe(false);
  });

  it("blocks the release when a critical test fails, whatever the score", async () => {
    const config = loadCheckConfig({ cwd: testRoot, configPath: configFile() });
    const result = await runCheck({
      config,
      diff,
      diffSource: "test fixture",
      runner: new StubRunner(true)
    });

    expect(result.gate.decision).toBe("RELEASE_BLOCKED");
    expect(result.gate.reasons.map((reason) => reason.code)).toContain("CRITICAL_TEST_FAILURE");
  });
});

describe("reports", () => {
  it("renders a self-contained HTML report with the decision and the evidence", async () => {
    const config = loadCheckConfig({ cwd: testRoot, configPath: configFile() });
    const result = await runCheck({
      config,
      diff,
      diffSource: "test fixture",
      runner: new StubRunner(true)
    });
    const html = renderHtmlReport(result);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Release blocked");
    expect(html).toContain("keeps the payment limit");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
  });

  it("escapes values coming from the analysed project", async () => {
    const config = loadCheckConfig({
      cwd: testRoot,
      configPath: configFile({ project: '<img src=x onerror="alert(1)">' })
    });
    const result = await runCheck({
      config,
      diff,
      diffSource: "test fixture",
      runner: new StubRunner(false)
    });
    const html = renderHtmlReport(result);

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("renders a terminal summary without control characters when colour is disabled", async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const config = loadCheckConfig({ cwd: testRoot, configPath: configFile() });
      const result = await runCheck({
        config,
        diff,
        diffSource: "test fixture",
        runner: new StubRunner(false)
      });
      const text = renderTerminalReport(result);

      expect(text).toContain("RELEASE_APPROVED");
      expect(text).toContain("Quality Score");
      expect(text).not.toContain(String.fromCharCode(27));
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
