import type { HistoryCommit } from "@evidence-gate/git-history";
import { describe, expect, it } from "vitest";
import { areaOf, buildInitialConfig, proposeCriticalityRules } from "./init.js";

const commit = (subject: string, files: string[], fix: boolean): HistoryCommit => ({
  sha: subject,
  subject,
  files,
  fix
});

const build = (overrides: Partial<Parameters<typeof buildInitialConfig>[0]> = {}) =>
  buildInitialConfig({
    manifest: { name: "@acme/checkout", devDependencies: { vitest: "^4.0.0" } },
    commits: [],
    testFiles: ["tests/limit.test.ts"],
    directoryName: "fallback-name",
    ...overrides
  });

const executionOf = (config: Record<string, unknown>) =>
  config.execution as { suites: { key: string; reportFormat: string; kind: string }[] };

describe("area grouping", () => {
  it("groups two directories deep", () => {
    expect(areaOf("src/payment/limit.ts")).toBe("src/payment");
    expect(areaOf("packages/core/src/index.ts")).toBe("packages/core");
  });

  it("groups one deep when the path is shallow", () => {
    expect(areaOf("src/index.ts")).toBe("src");
  });

  it("has no area for a file at the root", () => {
    expect(areaOf("README.md")).toBeNull();
  });
});

describe("criticality proposal", () => {
  it("ranks the area where fixes land at the top of the band", () => {
    const rules = proposeCriticalityRules([
      commit("fix: a", ["src/payment/limit.ts"], true),
      commit("fix: b", ["src/payment/limit.ts"], true),
      commit("fix: c", ["src/cart/cart.ts"], true),
      commit("feat: d", ["src/cart/cart.ts"], false)
    ]);

    expect(rules[0]).toEqual({
      pathPrefix: "src/payment/",
      area: "Payment",
      businessCriticality: 90
    });
    // Half the fixes of the busiest area lands halfway up the band.
    expect(rules[1]).toEqual({
      pathPrefix: "src/cart/",
      area: "Cart",
      businessCriticality: 65
    });
  });

  it("proposes nothing for an area that never had a fix", () => {
    const rules = proposeCriticalityRules([commit("feat: a", ["src/cart/cart.ts"], false)]);
    expect(rules).toEqual([]);
  });

  it("proposes nothing when there is no history at all", () => {
    expect(proposeCriticalityRules([])).toEqual([]);
  });

  it("orders ties by area name so the output is stable", () => {
    const rules = proposeCriticalityRules([
      commit("fix: b", ["src/zebra/a.ts"], true),
      commit("fix: a", ["src/alpha/a.ts"], true)
    ]);
    expect(rules.map((rule) => rule.pathPrefix)).toEqual(["src/alpha/", "src/zebra/"]);
  });
});

describe("runner detection", () => {
  it("detects vitest", () => {
    const suites = executionOf(build().config).suites;
    expect(suites).toHaveLength(1);
    expect(suites[0]?.reportFormat).toBe("vitest-json");
    expect(suites[0]?.key).toBe("unit");
  });

  it("detects jest when vitest is absent", () => {
    const suites = executionOf(
      build({ manifest: { name: "x", devDependencies: { jest: "^29.0.0" } } }).config
    ).suites;
    expect(suites[0]?.reportFormat).toBe("vitest-json");
    expect(JSON.stringify(suites[0])).toContain("jest");
  });

  it("prefers vitest when a project has both", () => {
    const suites = executionOf(
      build({ manifest: { name: "x", devDependencies: { jest: "^29.0.0", vitest: "^4.0.0" } } })
        .config
    ).suites;
    expect(suites).toHaveLength(1);
    expect(JSON.stringify(suites[0])).toContain("vitest");
  });

  it("adds a Playwright suite alongside the unit suite", () => {
    const suites = executionOf(
      build({
        manifest: {
          name: "x",
          devDependencies: { vitest: "^4.0.0", "@playwright/test": "^1.0.0" }
        }
      }).config
    ).suites;

    expect(suites.map((suite) => suite.key)).toEqual(["unit", "e2e"]);
    expect(suites[1]?.reportFormat).toBe("playwright-json");
  });

  it("warns instead of inventing a suite when no runner is present", () => {
    const result = build({ manifest: { name: "x" } });
    expect(executionOf(result.config).suites).toEqual([]);
    expect(result.warnings.join(" ")).toContain("No test runner was detected");
  });
});

describe("generated configuration", () => {
  it("slugifies a scoped package name", () => {
    expect(build().config.project).toBe("checkout");
  });

  it("falls back to the directory name without a manifest", () => {
    const result = build({ manifest: null });
    expect(result.config.project).toBe("fallback-name");
    expect(result.notes.join(" ")).toContain("taken from the directory");
  });

  it("never writes risk metrics, because the history counts them", () => {
    const result = build();
    expect(result.config.riskMetrics).toBeUndefined();
    expect(result.notes.join(" ")).toContain("counted from the git history");
  });

  it("says the criticality proposal describes history, not business value", () => {
    const result = build({
      commits: [commit("fix: a", ["src/payment/limit.ts"], true)]
    });
    expect(result.notes.join(" ")).toContain("history, not business value");
  });

  it("warns when there is no history and when there are no test files", () => {
    const result = build({ commits: [], testFiles: [] });
    expect(result.warnings.join(" ")).toContain("No commit history was readable");
    expect(result.warnings.join(" ")).toContain("No test file was found");
  });

  it("proposes the artefacts a project should ignore", () => {
    const result = build({ gitignore: "node_modules/\ndist/\n" });
    expect(result.gitignoreAdditions).toEqual([".evidence-gate/", "evidence-gate-report.html"]);
    expect(result.notes.join(" ")).toContain("Added to .gitignore");
  });

  it("proposes nothing when the entries are already ignored", () => {
    const result = build({
      gitignore: "node_modules/\n.evidence-gate/\nevidence-gate-report.html\n"
    });
    expect(result.gitignoreAdditions).toEqual([]);
  });

  it("accepts the directory entry with or without a trailing slash", () => {
    const result = build({ gitignore: ".evidence-gate\n" });
    expect(result.gitignoreAdditions).toEqual(["evidence-gate-report.html"]);
  });

  it("proposes every entry when the project has no gitignore", () => {
    const result = build({ gitignore: null });
    expect(result.gitignoreAdditions).toHaveLength(2);
  });

  it("warns when the history has commits but declares no fix", () => {
    const result = build({ commits: [commit("feat: a", ["src/a/b.ts"], false)] });
    expect(result.warnings.join(" ")).toContain("no commit declaring a fix");
  });
});
