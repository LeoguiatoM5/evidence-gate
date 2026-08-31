import { describe, expect, it } from "vitest";
import { parseVitestJsonReport } from "./report-vitest.js";
import { TestReportError } from "./report.js";

const report = {
  numTotalTests: 4,
  success: false,
  testResults: [
    {
      name: "D:/project/tests/unit/limit.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["payment limit"],
          fullName: "payment limit @critical blocks a payment over the ceiling",
          title: "@critical blocks a payment over the ceiling",
          status: "failed",
          duration: 3.4,
          failureMessages: ["expected 422 but got 200; authorization: Bearer abcdefghijklmnop"]
        },
        {
          ancestorTitles: ["payment limit"],
          fullName: "payment limit approves a payment inside the ceiling",
          title: "approves a payment inside the ceiling",
          status: "passed",
          duration: 1.2,
          failureMessages: []
        },
        {
          ancestorTitles: ["payment limit"],
          fullName: "payment limit handles refunds",
          title: "handles refunds",
          status: "skipped",
          duration: 0,
          failureMessages: []
        }
      ]
    },
    {
      name: "D:/project/tests/unit/broken.test.ts",
      status: "failed",
      message: "Cannot find module './missing.js'",
      assertionResults: []
    }
  ]
};

describe("vitest JSON report parser", () => {
  it("normalises assertions, marks @critical tests and redacts secrets", () => {
    const parsed = parseVitestJsonReport(report, {
      criticalByDefault: false,
      workingDirectory: "D:/project"
    });

    expect(parsed.suites).toHaveLength(1);
    const suite = parsed.suites[0];
    expect(suite?.file).toBe("tests/unit/limit.test.ts");
    expect(suite?.results).toHaveLength(3);

    const failing = suite?.results[0];
    expect(failing?.status).toBe("FAILED");
    expect(failing?.critical).toBe(true);
    expect(failing?.errorMessage).toContain("expected 422 but got 200");
    expect(failing?.errorMessage).not.toContain("abcdefghijklmnop");

    expect(suite?.results[1]?.status).toBe("PASSED");
    expect(suite?.results[1]?.critical).toBe(false);
    expect(suite?.results[2]?.status).toBe("SKIPPED");
  });

  it("reports a file that failed to load instead of dropping it silently", () => {
    const parsed = parseVitestJsonReport(report, {
      criticalByDefault: false,
      workingDirectory: "D:/project"
    });

    expect(parsed.reportErrors).toHaveLength(1);
    expect(parsed.reportErrors[0]).toContain("broken.test.ts");
    expect(parsed.reportErrors[0]).toContain("Cannot find module");
  });

  it("marks every test as critical when the suite itself is critical", () => {
    const parsed = parseVitestJsonReport(report, { criticalByDefault: true });
    expect(parsed.suites[0]?.results.every((result) => result.critical)).toBe(true);
  });

  it("rejects a report that is not in the expected shape", () => {
    expect(() => parseVitestJsonReport({ nope: true }, { criticalByDefault: false })).toThrow(
      TestReportError
    );
    expect(() => parseVitestJsonReport("not json", { criticalByDefault: false })).toThrow(
      TestReportError
    );
  });
});
