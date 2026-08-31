import type { GateReason, ReleaseDecision } from "@evidence-gate/core";
import type { CheckResult } from "./run-check.js";

/**
 * Markdown summary for a pull request comment and for the GitHub Actions run
 * summary. The first line is a stable marker so an existing comment can be found
 * and updated instead of a new one being posted on every run.
 */

export const COMMENT_MARKER = "<!-- evidence-gate-report -->";

const DECISION_COPY: Record<ReleaseDecision, { icon: string; label: string; summary: string }> = {
  RELEASE_APPROVED: {
    icon: "✅",
    label: "Release approved",
    summary: "The available evidence supports releasing this change."
  },
  REVIEW_REQUIRED: {
    icon: "⚠️",
    label: "Review required",
    summary: "The evidence is not sufficient for an automatic release. A human has to decide."
  },
  RELEASE_BLOCKED: {
    icon: "🚫",
    label: "Release blocked",
    summary: "At least one blocking rule was violated. A high score never overrides a blocker."
  }
};

const SEVERITY_ICON: Record<GateReason["severity"], string> = {
  CRITICAL: "❌",
  WARNING: "⚠️",
  INFO: "ℹ️"
};

/** Escapes the pipe so a value never breaks out of a Markdown table cell. */
const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

export interface MarkdownReportOptions {
  commitSha?: string;
}

const renderReasons = (reasons: readonly GateReason[]): string => {
  if (reasons.length === 0) return "_No gate rule produced an observation._";
  return reasons
    .map((reason) => {
      const detail =
        reason.actual === undefined
          ? ""
          : ` _(actual ${String(reason.actual)}, expected ${String(reason.expected ?? "—")})_`;
      return `- ${SEVERITY_ICON[reason.severity]} ${reason.message}${detail}`;
    })
    .join("\n");
};

const renderExecutions = (result: CheckResult): string => {
  if (result.executions.length === 0) {
    return "_No suite was selected, so there is no test evidence for this change._";
  }

  const rows = result.executions
    .map((execution) => {
      const results = execution.suites.flatMap((suite) => suite.results);
      const passed = results.filter((item) => item.status === "PASSED").length;
      const failed = results.filter(
        (item) => item.status === "FAILED" || item.status === "TIMED_OUT"
      ).length;
      const flaky = results.filter((item) => item.status === "FLAKY").length;
      const status = execution.status === "COMPLETED" ? "ok" : execution.status.toLowerCase();
      return `| \`${cell(execution.suiteKey)}\` | ${cell(execution.kind)} | ${status} | ${String(passed)} passed · ${String(failed)} failed · ${String(flaky)} flaky | ${String(execution.durationMs)} ms |`;
    })
    .join("\n");

  return [
    "| Suite | Kind | Execution | Results | Duration |",
    "|---|---|---|---|---|",
    rows
  ].join("\n");
};

const renderFailures = (result: CheckResult): string => {
  const failures = result.executions.flatMap((execution) =>
    execution.suites.flatMap((suite) =>
      suite.results.filter(
        (item) => item.status === "FAILED" || item.status === "TIMED_OUT" || item.status === "FLAKY"
      )
    )
  );
  if (failures.length === 0) return "";

  const rows = failures
    .slice(0, 20)
    .map(
      (failure) =>
        `| ${cell(failure.title)}${failure.critical ? " **(critical)**" : ""} | ${failure.status.toLowerCase()} | ${cell(failure.errorMessage ?? "—")} |`
    )
    .join("\n");
  const more =
    failures.length > 20 ? `\n\n_… and ${String(failures.length - 20)} more._` : "";

  return `

### Tests that did not pass

| Test | Status | Message |
|---|---|---|
${rows}${more}`;
};

const renderRiskFactors = (result: CheckResult): string => {
  const rows = result.risk.factors
    .map(
      (factor) =>
        `| ${cell(factor.key)} | ${formatNumber(factor.contribution)} / ${String(factor.weight)} | ${factor.available ? "yes" : "**no — conservative fallback**"} |`
    )
    .join("\n");

  return `

<details>
<summary>Risk factor contributions</summary>

| Factor | Contribution | Evidence |
|---|---|---|
${rows}

</details>`;
};

export const renderMarkdownReport = (
  result: CheckResult,
  options: MarkdownReportOptions = {}
): string => {
  const decision = DECISION_COPY[result.gate.decision];
  const broken = result.executionBroken
    ? "\n> **Warning:** at least one suite did not finish in a usable way (crash or timeout). This decision must not be treated as release evidence.\n"
    : "";
  const commit = options.commitSha ? ` · commit \`${options.commitSha.slice(0, 7)}\`` : "";

  return `${COMMENT_MARKER}
## ${decision.icon} ${decision.label}

\`${result.gate.decision}\` — ${decision.summary}
${broken}
| Quality Score | Risk Score | Evidence confidence |
|---|---|---|
| **${String(result.quality.score)}** (85 approves) | **${String(result.risk.score)}** (${result.risk.level}) | **${String(result.quality.confidence)}** |

### Why this decision

${renderReasons(result.gate.reasons)}

### Test execution

${renderExecutions(result)}${renderFailures(result)}${renderRiskFactors(result)}

<sub>${cell(result.projectName)} · ${String(result.repositoryAnalysis.changes.length)} file(s) · areas: ${cell(result.repositoryAnalysis.affectedAreas.join(", "))} · policy ${cell(result.policyVersion)}${commit}</sub>
`;
};
