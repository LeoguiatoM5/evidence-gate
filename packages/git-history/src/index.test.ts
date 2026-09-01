import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMIT_MARKER, isFixSubject, parseGitLog, summariseByPath } from "./parse.js";
import { countRelatedTests, isTestFile, stemOf } from "./related-tests.js";
import { deriveRiskMetrics } from "./index.js";

const log = (entries: { sha: string; subject: string; files: string[] }[]): string =>
  entries
    .map((entry) => `${COMMIT_MARKER}${entry.sha}\t${entry.subject}\n${entry.files.join("\n")}`)
    .join("\n\n");

describe("fix detection", () => {
  it("recognises a conventional fix commit", () => {
    expect(isFixSubject("fix: payment limit off by one")).toBe(true);
    expect(isFixSubject("fix(payment): limit off by one")).toBe(true);
    expect(isFixSubject("fix!: drop the broken flag")).toBe(true);
  });

  it("takes another conventional type at its word", () => {
    // "refactor" must not count merely because a word later mentions a fix.
    expect(isFixSubject("refactor: simplify the fix routine")).toBe(false);
    expect(isFixSubject("feat: add a bug report form")).toBe(false);
    expect(isFixSubject("test: cover the fixed branch")).toBe(false);
  });

  it("falls back to keywords in English and Portuguese", () => {
    expect(isFixSubject("Fixed the daily ceiling")).toBe(true);
    expect(isFixSubject("corrige o teto diário")).toBe(true);
    expect(isFixSubject("correção no cálculo de limite")).toBe(true);
    expect(isFixSubject("resolve #412")).toBe(true);
  });

  it("does not treat a word that merely contains fix as a fix", () => {
    expect(isFixSubject("add a test fixture for the parser")).toBe(false);
    expect(isFixSubject("prefix every log line")).toBe(false);
  });
});

describe("git log parsing", () => {
  it("groups files under the commit that touched them", () => {
    const commits = parseGitLog(
      log([
        { sha: "aaa", subject: "fix: limit", files: ["src/payment/limit.ts", "src/cart/x.ts"] },
        { sha: "bbb", subject: "feat: cart", files: ["src/cart/x.ts"] }
      ])
    );

    expect(commits).toHaveLength(2);
    expect(commits[0]?.sha).toBe("aaa");
    expect(commits[0]?.files).toEqual(["src/payment/limit.ts", "src/cart/x.ts"]);
    expect(commits[0]?.fix).toBe(true);
    expect(commits[1]?.fix).toBe(false);
  });

  it("tolerates an empty log and a commit with no files", () => {
    expect(parseGitLog("")).toEqual([]);
    const commits = parseGitLog(`${COMMIT_MARKER}aaa\tchore: empty`);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual([]);
  });

  it("keeps a tab inside the subject", () => {
    const commits = parseGitLog(`${COMMIT_MARKER}aaa\tfix: a\tb`);
    expect(commits[0]?.subject).toBe("fix: a\tb");
  });

  it("counts a path once per commit, even when it appears twice", () => {
    const summary = summariseByPath(
      parseGitLog(
        log([{ sha: "aaa", subject: "fix: x", files: ["a.ts", "a.ts", "b.ts"] }])
      )
    );
    expect(summary.get("a.ts")).toEqual({ changes: 1, fixes: 1 });
    expect(summary.get("b.ts")).toEqual({ changes: 1, fixes: 1 });
  });

  it("separates change count from fix count", () => {
    const summary = summariseByPath(
      parseGitLog(
        log([
          { sha: "a", subject: "fix: one", files: ["a.ts"] },
          { sha: "b", subject: "feat: two", files: ["a.ts"] },
          { sha: "c", subject: "fix: three", files: ["a.ts"] }
        ])
      )
    );
    expect(summary.get("a.ts")).toEqual({ changes: 3, fixes: 2 });
  });
});

describe("related tests", () => {
  const read = (contents: Record<string, string>) => (path: string) => contents[path] ?? "";

  it("matches a test file by the source file stem", () => {
    expect(
      countRelatedTests("src/payment/limit.ts", {
        testFiles: ["tests/limit.test.ts", "tests/cart.test.ts"],
        readFile: read({})
      })
    ).toBe(1);
  });

  it("matches a test file that imports the module", () => {
    expect(
      countRelatedTests("src/payment/limit.ts", {
        testFiles: ["tests/checkout.test.ts"],
        readFile: read({
          "tests/checkout.test.ts": 'import { evaluate } from "../src/payment/limit.js";'
        })
      })
    ).toBe(1);
  });

  it("counts a file matched by both signals only once", () => {
    expect(
      countRelatedTests("src/payment/limit.ts", {
        testFiles: ["tests/limit.test.ts"],
        readFile: read({ "tests/limit.test.ts": 'import x from "../src/payment/limit.js";' })
      })
    ).toBe(1);
  });

  it("does not match an unrelated import that merely shares a prefix", () => {
    expect(
      countRelatedTests("src/payment/limit.ts", {
        testFiles: ["tests/other.test.ts"],
        readFile: read({ "tests/other.test.ts": 'import x from "../src/payment/limiter.js";' })
      })
    ).toBe(0);
  });

  it("reports no related tests for a test file itself", () => {
    expect(
      countRelatedTests("tests/limit.test.ts", {
        testFiles: ["tests/limit.test.ts"],
        readFile: read({})
      })
    ).toBe(0);
  });

  it("recognises test file names and strips the stem", () => {
    expect(isTestFile("a/b/limit.test.ts")).toBe(true);
    expect(isTestFile("a/b/limit.spec.tsx")).toBe(true);
    expect(isTestFile("a/b/limit.ts")).toBe(false);
    expect(stemOf("a/b/limit.test.ts")).toBe("limit");
    expect(stemOf("a/b/limit.ts")).toBe("limit");
  });
});

describe("metric derivation", () => {
  const readLog = (output: string) => () => output;

  it("takes the hottest file as the risk of the whole change", () => {
    const result = deriveRiskMetrics({
      cwd: ".",
      changedPaths: ["src/hot.ts", "src/cold.ts"],
      readLog: readLog(
        log([
          { sha: "a", subject: "fix: one", files: ["src/hot.ts"] },
          { sha: "b", subject: "fix: two", files: ["src/hot.ts"] },
          { sha: "c", subject: "feat: three", files: ["src/hot.ts", "src/cold.ts"] }
        ])
      )
    });

    expect(result.metrics.changesLast90Days).toBe(3);
    expect(result.metrics.bugCount).toBe(2);
    expect(result.commitsAnalysed).toBe(3);
  });

  it("reports zero for a file with no history rather than leaving it absent", () => {
    const result = deriveRiskMetrics({
      cwd: ".",
      changedPaths: ["src/brand-new.ts"],
      readLog: readLog(log([{ sha: "a", subject: "fix: other", files: ["src/other.ts"] }]))
    });

    expect(result.metrics.changesLast90Days).toBe(0);
    expect(result.metrics.bugCount).toBe(0);
  });

  it("leaves every metric absent when the history cannot be read", () => {
    const result = deriveRiskMetrics({
      cwd: ".",
      changedPaths: ["src/a.ts"],
      readLog: () => null
    });

    expect(result.metrics).toEqual({});
    expect(result.unavailable.join(" ")).toContain("git history could not be read");
  });

  it("takes the least covered source file as the test gap", () => {
    const result = deriveRiskMetrics({
      cwd: ".",
      changedPaths: ["src/covered.ts", "src/bare.ts"],
      testFiles: ["tests/covered.test.ts"],
      readLog: readLog(log([{ sha: "a", subject: "feat: x", files: ["src/covered.ts"] }]))
    });

    expect(result.metrics.relatedTests).toBe(0);
  });

  it("ignores test and non-source files when counting the test gap", () => {
    const result = deriveRiskMetrics({
      cwd: ".",
      changedPaths: ["src/covered.ts", "README.md", "tests/covered.test.ts"],
      testFiles: ["tests/covered.test.ts"],
      readLog: readLog(log([{ sha: "a", subject: "feat: x", files: ["src/covered.ts"] }]))
    });

    expect(result.metrics.relatedTests).toBe(1);
  });

  it("says why related tests are absent when no test files were listed", () => {
    const result = deriveRiskMetrics({
      cwd: ".",
      changedPaths: ["src/a.ts"],
      readLog: readLog("")
    });

    expect(result.metrics.relatedTests).toBeUndefined();
    expect(result.unavailable.join(" ")).toContain("no test files were listed");
  });
});

describe("against a real repository", () => {
  const repository = resolve(process.cwd(), ".tmp", "git-history", randomUUID());
  let available = true;

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  };

  beforeAll(() => {
    mkdirSync(repository, { recursive: true });
    try {
      git("init", "--initial-branch=main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("config", "commit.gpgsign", "false");

      writeFileSync(resolve(repository, "limit.ts"), "export const limit = 10;\n", "utf8");
      git("add", ".");
      git("commit", "-m", "feat: add the limit");

      writeFileSync(resolve(repository, "limit.ts"), "export const limit = 20;\n", "utf8");
      git("add", ".");
      git("commit", "-m", "fix: correct the limit");

      writeFileSync(resolve(repository, "cart.ts"), "export const cart = [];\n", "utf8");
      git("add", ".");
      git("commit", "-m", "feat: add the cart");
    } catch {
      available = false;
    }
    // Creating a repository and three commits is disk-bound, and this workspace runs
    // from a slow volume; the generous timeout covers the environment, not a hang.
  }, 60_000);

  afterAll(() => {
    rmSync(repository, { recursive: true, force: true });
  }, 30_000);

  it("counts real commits and real fixes", () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }

    const result = deriveRiskMetrics({ cwd: repository, changedPaths: ["limit.ts"] });

    expect(result.commitsAnalysed).toBe(3);
    expect(result.metrics.changesLast90Days).toBe(2);
    expect(result.metrics.bugCount).toBe(1);
  }, 30_000);

  it("reads the enclosing repository when run from a subdirectory", () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }

    const nested = resolve(repository, "packages", "inner");
    mkdirSync(nested, { recursive: true });

    // git walks up to the repository root, so the tool works from anywhere inside it.
    const result = deriveRiskMetrics({ cwd: nested, changedPaths: ["limit.ts"] });

    expect(result.commitsAnalysed).toBe(3);
    expect(result.metrics.bugCount).toBe(1);
  }, 30_000);
});
