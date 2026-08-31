import type { ReleaseDecision } from "@evidence-gate/core";
import type { CheckResult } from "./run-check.js";

const useColor = (): boolean =>
  process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && process.stdout.isTTY !== false;

const ESC = String.fromCharCode(27);

const paint = (code: string, text: string): string =>
  useColor() ? `${ESC}[${code}m${text}${ESC}[0m` : text;

const bold = (text: string): string => paint("1", text);
const dim = (text: string): string => paint("2", text);
const green = (text: string): string => paint("32", text);
const yellow = (text: string): string => paint("33", text);
const red = (text: string): string => paint("31", text);

const DECISION_STYLE: Record<ReleaseDecision, { icon: string; paint: (text: string) => string }> = {
  RELEASE_APPROVED: { icon: "PASS", paint: green },
  REVIEW_REQUIRED: { icon: "WARN", paint: yellow },
  RELEASE_BLOCKED: { icon: "FAIL", paint: red }
};

const bar = (value: number, width = 24): string => {
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return `${"█".repeat(filled)}${dim("░".repeat(width - filled))}`;
};

const pad = (text: string, width: number): string =>
  text.length >= width ? text.slice(0, width) : text.padEnd(width, " ");

export const renderTerminalReport = (result: CheckResult): string => {
  const lines: string[] = [];
  const style = DECISION_STYLE[result.gate.decision];

  lines.push("");
  lines.push(
    `  ${style.paint(bold(`[${style.icon}] ${result.gate.decision}`))}  ${dim(result.projectName)}`
  );
  lines.push("");
  lines.push(
    `  Quality Score  ${bold(pad(String(result.quality.score), 4))}${bar(result.quality.score)}`
  );
  lines.push(
    `  Risk Score     ${bold(pad(String(result.risk.score), 4))}${bar(result.risk.score)}  ${dim(result.risk.level)}`
  );
  lines.push(
    `  Confidence     ${bold(pad(String(result.quality.confidence), 4))}${bar(result.quality.confidence)}`
  );
  lines.push("");

  if (result.gate.reasons.length > 0) {
    lines.push(`  ${bold("Why")}`);
    for (const reason of result.gate.reasons) {
      const marker =
        reason.severity === "CRITICAL" ? red("×") : reason.severity === "WARNING" ? yellow("!") : dim("·");
      const detail =
        reason.actual === undefined
          ? ""
          : dim(` (actual ${String(reason.actual)}, expected ${String(reason.expected ?? "-")})`);
      lines.push(`   ${marker} ${reason.message}${detail}`);
    }
    lines.push("");
  }

  const totals = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const execution of result.executions) {
    for (const suite of execution.suites) {
      for (const testResult of suite.results) {
        if (testResult.status === "PASSED") totals.passed += 1;
        else if (testResult.status === "SKIPPED") totals.skipped += 1;
        else if (testResult.status === "FLAKY") totals.flaky += 1;
        else totals.failed += 1;
      }
    }
  }

  lines.push(`  ${bold("Execution")}`);
  if (result.executions.length === 0) {
    lines.push(`   ${dim("no suite selected — no test evidence")}`);
  } else {
    for (const execution of result.executions) {
      const marker = execution.status === "COMPLETED" ? green("ok") : red(execution.status.toLowerCase());
      lines.push(
        `   ${marker} ${pad(execution.suiteKey, 18)} ${dim(`${execution.kind} · ${String(execution.durationMs)}ms · ${execution.runner}`)}`
      );
      if (execution.errorMessage) lines.push(`      ${red(execution.errorMessage.split("\n")[0] ?? "")}`);
    }
    lines.push(
      `   ${dim(`${String(totals.passed)} passed · ${String(totals.failed)} failed · ${String(totals.flaky)} flaky · ${String(totals.skipped)} skipped`)}`
    );
  }
  if (result.mutation) {
    const mutation = result.mutation.mutation;
    lines.push("");
    lines.push(`  ${bold("Mutation")}`);
    if (mutation) {
      lines.push(
        `   ${green("ok")} score ${String(mutation.mutationScore)}  ${dim(`${String(mutation.totals.killed)} killed · ${String(mutation.totals.survived)} survived · ${String(mutation.totals.noCoverage)} uncovered · ${String(mutation.totals.timeout)} timeout`)}`
      );
      if (mutation.survivedCriticalMutants > 0) {
        lines.push(
          `   ${red("×")} ${String(mutation.survivedCriticalMutants)} survivor(s) in a critical area`
        );
      }
    } else {
      lines.push(`   ${red(result.mutation.status.toLowerCase())} ${dim(result.mutation.errorMessage ?? "no mutation evidence")}`);
    }
  }

  lines.push("");

  const failedTests = result.executions.flatMap((execution) =>
    execution.suites.flatMap((suite) =>
      suite.results.filter((testResult) => testResult.status === "FAILED" || testResult.status === "TIMED_OUT")
    )
  );
  if (failedTests.length > 0) {
    lines.push(`  ${bold("Failing tests")}`);
    for (const testResult of failedTests.slice(0, 10)) {
      const tag = testResult.critical ? red(" [critical]") : "";
      lines.push(`   ${red("×")} ${testResult.title}${tag}`);
      if (testResult.errorMessage) {
        lines.push(`      ${dim(testResult.errorMessage.split("\n")[0] ?? "")}`);
      }
    }
    if (failedTests.length > 10) {
      lines.push(`   ${dim(`... and ${String(failedTests.length - 10)} more`)}`);
    }
    lines.push("");
  }

  lines.push(
    `  ${dim(`${String(result.repositoryAnalysis.changes.length)} files · ${String(result.repositoryAnalysis.totalChangedLines)} lines · areas: ${result.repositoryAnalysis.affectedAreas.join(", ")}`)}`
  );
  lines.push(`  ${dim(`${result.diffSource} · policy ${result.policyVersion}`)}`);
  lines.push("");

  return lines.join("\n");
};
