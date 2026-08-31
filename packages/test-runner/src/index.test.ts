import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubprocessTestRunner } from "./index.js";
import type { AllowedSuite, ExecutionPolicy } from "./policy.js";
import { ExecutionPolicyError, SuiteNotAllowedError, assertExecutionPolicy } from "./policy.js";

const testRoot = resolve(process.cwd(), ".tmp", "test-runner", randomUUID());
const scriptsRoot = resolve(testRoot, "scripts");
const artifactsRoot = resolve(testRoot, "artifacts");

const writeScript = (name: string, source: string): string => {
  const path = resolve(scriptsRoot, name);
  writeFileSync(path, source, "utf8");
  return path;
};

const playwrightReportSource = `
const { writeFileSync } = require("node:fs");
const report = {
  config: { version: "1.0.0" },
  suites: [
    {
      title: "checkout.spec.ts",
      file: "tests/checkout.spec.ts",
      specs: [
        {
          title: "keeps the payment limit @critical",
          id: "spec-payment-limit",
          file: "tests/checkout.spec.ts",
          tags: ["@critical"],
          tests: [
            {
              projectName: "chromium",
              status: "expected",
              results: [{ status: "passed", duration: 120, attachments: [] }]
            }
          ]
        },
        {
          title: "shows the cart total",
          id: "spec-cart-total",
          file: "tests/checkout.spec.ts",
          tags: [],
          tests: [
            {
              projectName: "chromium",
              status: "flaky",
              results: [
                { status: "failed", duration: 90, attachments: [], error: { message: "flaky once" } },
                { status: "passed", duration: 80, attachments: [] }
              ]
            }
          ]
        }
      ],
      suites: [
        {
          title: "guest checkout",
          file: "tests/checkout.spec.ts",
          specs: [
            {
              title: "blocks an unpaid order",
              id: "spec-unpaid-order",
              file: "tests/checkout.spec.ts",
              tags: [],
              tests: [
                {
                  projectName: "chromium",
                  status: "unexpected",
                  results: [
                    {
                      status: "failed",
                      duration: 200,
                      attachments: [],
                      error: { message: "expected 200 but got 500; authorization: Bearer abcdefghijklmnop" }
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  errors: []
};
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report), "utf8");
console.log("running suite with token ghp_0123456789abcdefghij");
process.exit(0);
`;

const crashingSource = `
console.error("playwright crashed before writing a report");
process.exit(1);
`;

const hangingSource = `
console.log("started");
setInterval(() => {}, 1000);
`;

const noisySource = `
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [] }), "utf8");
for (let index = 0; index < 200; index += 1) {
  console.log("x".repeat(200));
}
process.exit(0);
`;

const suite = (key: string, scriptPath: string, critical = false): AllowedSuite => ({
  key,
  kind: "REGRESSION",
  command: process.execPath,
  args: [scriptPath],
  critical,
  reportFormat: "playwright-json"
});

let policy: ExecutionPolicy;

beforeAll(() => {
  mkdirSync(scriptsRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  policy = {
    workingDirectory: scriptsRoot,
    artifactsRoot,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    suites: [
      suite("passing-suite", writeScript("passing.cjs", playwrightReportSource), true),
      suite("crashing-suite", writeScript("crashing.cjs", crashingSource)),
      suite("hanging-suite", writeScript("hanging.cjs", hangingSource)),
      suite("noisy-suite", writeScript("noisy.cjs", noisySource))
    ]
  };
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("execution policy", () => {
  it("rejects a command that is not an absolute path", () => {
    expect(() =>
      assertExecutionPolicy({
        ...policy,
        suites: [
          {
            key: "relative",
            kind: "SMOKE",
            command: "node",
            args: [],
            critical: false,
            reportFormat: "playwright-json"
          }
        ]
      })
    ).toThrow(ExecutionPolicyError);
  });

  it("rejects a working directory that does not exist", () => {
    expect(() =>
      assertExecutionPolicy({ ...policy, workingDirectory: resolve(testRoot, "missing") })
    ).toThrow(ExecutionPolicyError);
  });

  it("refuses to run a suite that is not allow-listed", async () => {
    const runner = new SubprocessTestRunner({ policy });
    await expect(
      runner.run({ analysisId: "analysis-1", suiteKey: "rm-rf-suite" })
    ).rejects.toBeInstanceOf(SuiteNotAllowedError);
  });
});

describe("Playwright execution", () => {
  it("executes an allowed suite and normalises the JSON report", async () => {
    const runner = new SubprocessTestRunner({ policy });
    const report = await runner.run({ analysisId: "analysis-success", suiteKey: "passing-suite" });

    expect(report.status).toBe("COMPLETED");
    expect(report.exitCode).toBe(0);
    expect(report.timedOut).toBe(false);

    const results = report.suites.flatMap((parsedSuite) => parsedSuite.results);
    expect(results).toHaveLength(3);

    const passing = results.find((result) => result.identity === "spec-payment-limit");
    expect(passing?.status).toBe("PASSED");
    expect(passing?.critical).toBe(true);

    const flaky = results.find((result) => result.identity === "spec-cart-total");
    expect(flaky?.status).toBe("FLAKY");
    expect(flaky?.retries).toBe(1);

    const failing = results.find((result) => result.identity === "spec-unpaid-order");
    expect(failing?.status).toBe("FAILED");
    expect(failing?.errorMessage).toContain("expected 200 but got 500");
    expect(failing?.errorMessage).not.toContain("abcdefghijklmnop");

    const artifactTypes = report.artifacts.map((artifact) => artifact.type);
    expect(artifactTypes).toContain("JSON_REPORT");
    expect(artifactTypes).toContain("PROCESS_OUTPUT");
    for (const artifact of report.artifacts) {
      expect(artifact.path.startsWith("analysis-success/passing-suite/")).toBe(true);
    }

    const outputArtifact = report.artifacts.find((artifact) => artifact.type === "PROCESS_OUTPUT");
    const capturedOutput = readFileSync(resolve(artifactsRoot, outputArtifact?.path ?? ""), "utf8");
    expect(capturedOutput).toContain("running suite with token");
    expect(capturedOutput).not.toContain("ghp_0123456789abcdefghij");
  }, 30_000);

  it("reports a crashed suite as FAILED instead of inventing results", async () => {
    const runner = new SubprocessTestRunner({ policy });
    const report = await runner.run({ analysisId: "analysis-crash", suiteKey: "crashing-suite" });

    expect(report.status).toBe("FAILED");
    expect(report.exitCode).toBe(1);
    expect(report.suites).toHaveLength(0);
    expect(report.errorMessage).toContain("expected JSON report");
  }, 30_000);

  it("kills a suite that exceeds the configured timeout", async () => {
    const runner = new SubprocessTestRunner({ policy: { ...policy, timeoutMs: 1200 } });
    const startedAt = Date.now();
    const report = await runner.run({ analysisId: "analysis-timeout", suiteKey: "hanging-suite" });

    expect(report.status).toBe("TIMED_OUT");
    expect(report.timedOut).toBe(true);
    expect(report.suites).toHaveLength(0);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }, 30_000);

  it("truncates output beyond the configured budget", async () => {
    const runner = new SubprocessTestRunner({ policy: { ...policy, maxOutputBytes: 1024 } });
    const report = await runner.run({ analysisId: "analysis-noisy", suiteKey: "noisy-suite" });

    expect(report.outputTruncated).toBe(true);
    const outputArtifact = report.artifacts.find((artifact) => artifact.type === "PROCESS_OUTPUT");
    expect(outputArtifact?.sizeBytes).toBeLessThan(4096);
  }, 30_000);
});
