import type { GateReason, ReleaseDecision, TestStatus } from "@evidence-gate/core";
import type { CheckResult } from "./run-check.js";

/**
 * Self-contained HTML report: no scripts, no network requests, no external fonts.
 * Every value is directly labelled, so nothing depends on hover or on colour alone.
 */

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const DECISION_COPY: Record<ReleaseDecision, { label: string; status: string; summary: string }> = {
  RELEASE_APPROVED: {
    label: "Release approved",
    status: "good",
    summary: "The available evidence supports releasing this change."
  },
  REVIEW_REQUIRED: {
    label: "Review required",
    status: "warning",
    summary: "The evidence is not sufficient for an automatic release. A human has to decide."
  },
  RELEASE_BLOCKED: {
    label: "Release blocked",
    status: "critical",
    summary: "At least one blocking rule was violated. A high score never overrides a blocker."
  }
};

const SEVERITY_ICON: Record<GateReason["severity"], { glyph: string; status: string; label: string }> = {
  CRITICAL: { glyph: "&#10005;", status: "critical", label: "Blocker" },
  WARNING: { glyph: "&#33;", status: "warning", label: "Warning" },
  INFO: { glyph: "&#8226;", status: "neutral", label: "Info" }
};

const TEST_STATUS_COPY: Record<TestStatus, { label: string; status: string }> = {
  PASSED: { label: "passed", status: "good" },
  FAILED: { label: "failed", status: "critical" },
  TIMED_OUT: { label: "timed out", status: "critical" },
  FLAKY: { label: "flaky", status: "warning" },
  SKIPPED: { label: "skipped", status: "neutral" }
};

/** Bar with a 4px rounded data-end, square at the baseline, over a receding track. */
const meter = (value: number, max = 100): string => {
  const percentage = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return `<span class="meter"><span class="meter-fill" style="width:${percentage.toFixed(1)}%"></span></span>`;
};

const row = (label: string, value: string, barValue: number, max: number, note?: string): string => `
      <tr>
        <th scope="row">${escapeHtml(label)}${note ? `<span class="note">${escapeHtml(note)}</span>` : ""}</th>
        <td class="bar-cell">${meter(barValue, max)}</td>
        <td class="value-cell">${escapeHtml(value)}</td>
      </tr>`;

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

const RISK_FACTOR_LABELS: Record<string, string> = {
  businessCriticality: "Business criticality",
  changeSize: "Change size",
  bugHistory: "Bug history",
  coverageGap: "Coverage gap",
  mutationGap: "Mutation gap",
  previousFailures: "Previous failures",
  changeFrequency: "Change frequency",
  relatedTestGap: "Related test gap"
};

const QUALITY_COMPONENT_LABELS: Record<string, string> = {
  regression: "Regression",
  mutation: "Mutation",
  riskControl: "Risk control",
  api: "API",
  testStability: "Test stability",
  coverage: "Coverage",
  evidenceCompleteness: "Evidence completeness"
};

const styles = `
  :root {
    color-scheme: light;
    --page: #f9f9f7;
    --surface: #fcfcfb;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --border: rgba(11, 11, 11, 0.10);
    --gridline: #e1e0d9;
    --meter-fill: #2a78d6;
    --meter-track: rgba(42, 120, 214, 0.16);
    --status-good: #0ca30c;
    --status-warning: #fab219;
    --status-critical: #d03b3b;
    --status-neutral: #898781;
    --good-wash: rgba(12, 163, 12, 0.10);
    --warning-wash: rgba(250, 178, 25, 0.14);
    --critical-wash: rgba(208, 59, 59, 0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page: #0d0d0d;
      --surface: #1a1a19;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --border: rgba(255, 255, 255, 0.10);
      --gridline: #2c2c2a;
      --meter-fill: #3987e5;
      --meter-track: rgba(57, 135, 229, 0.22);
      --good-wash: rgba(12, 163, 12, 0.16);
      --warning-wash: rgba(250, 178, 25, 0.16);
      --critical-wash: rgba(208, 59, 59, 0.16);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 64px;
    background: var(--page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.5;
  }
  main { max-width: 940px; margin: 0 auto; }
  header.page-head { margin-bottom: 20px; }
  .eyebrow {
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 4px;
  }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  .subtle { color: var(--text-secondary); font-size: 13px; margin: 0; }
  section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  h2 {
    font-size: 13px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 14px;
    font-weight: 600;
  }
  .hero { display: flex; gap: 16px; align-items: flex-start; }
  .hero-mark {
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    font-size: 22px;
    line-height: 1;
    font-weight: 700;
  }
  .hero-mark[data-status="good"] { background: var(--good-wash); color: var(--status-good); }
  .hero-mark[data-status="warning"] { background: var(--warning-wash); color: #8a5d00; }
  .hero-mark[data-status="critical"] { background: var(--critical-wash); color: var(--status-critical); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .hero-mark[data-status="warning"] { color: var(--status-warning); }
  }
  .hero-decision { font-size: 30px; font-weight: 600; margin: 0; line-height: 1.15; }
  .hero-code { font-size: 12px; color: var(--text-muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .hero p { margin: 6px 0 0; color: var(--text-secondary); max-width: 62ch; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; }
  .tile { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .tile-label { font-size: 12px; color: var(--text-muted); margin: 0 0 2px; }
  .tile-value { font-size: 32px; font-weight: 600; margin: 0; line-height: 1.1; }
  .tile-note { font-size: 12px; color: var(--text-secondary); margin: 4px 0 0; }
  .meter {
    display: block;
    position: relative;
    width: 100%;
    height: 10px;
    background: var(--meter-track);
    border-radius: 0 4px 4px 0;
    overflow: hidden;
  }
  .meter-fill {
    display: block;
    height: 100%;
    background: var(--meter-fill);
    border-radius: 0 4px 4px 0;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 0; vertical-align: middle; font-weight: 400; }
  tbody tr + tr th, tbody tr + tr td { border-top: 1px solid var(--gridline); }
  th[scope="row"] { width: 40%; color: var(--text-primary); padding-right: 16px; }
  .bar-cell { width: 42%; padding-right: 16px; }
  .value-cell {
    width: 18%;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .note { display: block; font-size: 12px; color: var(--text-muted); }
  ul.reasons { list-style: none; margin: 0; padding: 0; }
  ul.reasons li { display: flex; gap: 10px; padding: 9px 0; align-items: baseline; }
  ul.reasons li + li { border-top: 1px solid var(--gridline); }
  .chip {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .chip[data-status="good"] { background: var(--good-wash); color: var(--status-good); }
  .chip[data-status="warning"] { background: var(--warning-wash); color: #8a5d00; }
  .chip[data-status="critical"] { background: var(--critical-wash); color: var(--status-critical); }
  .chip[data-status="neutral"] { background: var(--gridline); color: var(--text-secondary); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .chip[data-status="warning"] { color: var(--status-warning); }
  }
  .reason-body { flex: 1 1 auto; }
  .reason-detail { display: block; font-size: 12px; color: var(--text-muted); }
  .scroll { overflow-x: auto; }
  table.data { font-size: 14px; }
  table.data th[scope="col"] {
    font-size: 12px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--gridline);
    padding-bottom: 6px;
  }
  table.data td { padding: 7px 12px 7px 0; }
  code {
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    font-size: 13px;
  }
  .empty { color: var(--text-muted); margin: 0; }
  footer { color: var(--text-muted); font-size: 12px; text-align: center; margin-top: 24px; }
  @media print {
    body { background: #ffffff; padding: 0; }
    section { break-inside: avoid; }
  }
`;

const renderReasons = (reasons: readonly GateReason[]): string => {
  if (reasons.length === 0) {
    return '<p class="empty">No gate rule produced an observation.</p>';
  }
  const items = reasons
    .map((reason) => {
      const icon = SEVERITY_ICON[reason.severity];
      const detail =
        reason.actual === undefined
          ? ""
          : `<span class="reason-detail">actual ${escapeHtml(String(reason.actual))} · expected ${escapeHtml(
              String(reason.expected ?? "—")
            )}</span>`;
      return `
        <li>
          <span class="chip" data-status="${icon.status}">${icon.glyph} ${escapeHtml(icon.label)}</span>
          <span class="reason-body">${escapeHtml(reason.message)}${detail}
            <span class="reason-detail"><code>${escapeHtml(reason.code)}</code></span>
          </span>
        </li>`;
    })
    .join("");
  return `<ul class="reasons">${items}</ul>`;
};

const renderExecutions = (result: CheckResult): string => {
  if (result.executions.length === 0) {
    return '<p class="empty">No suite was selected, so there is no test evidence for this change.</p>';
  }

  const rows = result.executions
    .map((execution) => {
      const results = execution.suites.flatMap((suite) => suite.results);
      const passed = results.filter((item) => item.status === "PASSED").length;
      const failed = results.filter(
        (item) => item.status === "FAILED" || item.status === "TIMED_OUT"
      ).length;
      const flaky = results.filter((item) => item.status === "FLAKY").length;
      const status =
        execution.status === "COMPLETED" ? { label: "completed", tone: "good" } : { label: execution.status.toLowerCase(), tone: "critical" };
      return `
        <tr>
          <td><code>${escapeHtml(execution.suiteKey)}</code></td>
          <td>${escapeHtml(execution.kind)}</td>
          <td><span class="chip" data-status="${status.tone}">${escapeHtml(status.label)}</span></td>
          <td>${String(passed)} ok · ${String(failed)} failed · ${String(flaky)} flaky</td>
          <td>${String(execution.durationMs)} ms</td>
          <td>${escapeHtml(execution.runner)}</td>
        </tr>`;
    })
    .join("");

  return `
      <div class="scroll">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Suite</th>
              <th scope="col">Kind</th>
              <th scope="col">Execution</th>
              <th scope="col">Results</th>
              <th scope="col">Duration</th>
              <th scope="col">Runner</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
};

const renderFailedTests = (result: CheckResult): string => {
  const failures = result.executions.flatMap((execution) =>
    execution.suites.flatMap((suite) =>
      suite.results
        .filter((item) => item.status === "FAILED" || item.status === "TIMED_OUT" || item.status === "FLAKY")
        .map((item) => ({ suite: suite.title, ...item }))
    )
  );
  if (failures.length === 0) return "";

  const rows = failures
    .map((failure) => {
      const copy = TEST_STATUS_COPY[failure.status];
      return `
        <tr>
          <td>
            ${escapeHtml(failure.title)}
            ${failure.critical ? '<span class="chip" data-status="critical">critical</span>' : ""}
            <span class="reason-detail">${escapeHtml(failure.suite)}</span>
          </td>
          <td><span class="chip" data-status="${copy.status}">${escapeHtml(copy.label)}</span></td>
          <td><span class="reason-detail">${escapeHtml(failure.errorMessage ?? "—")}</span></td>
        </tr>`;
    })
    .join("");

  return `
    <section>
      <h2>Tests that did not pass</h2>
      <div class="scroll">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Test</th>
              <th scope="col">Status</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
};

const renderMutation = (result: CheckResult): string => {
  if (!result.mutation) return "";
  const mutation = result.mutation.mutation;

  if (!mutation) {
    return `
    <section>
      <h2>Mutation testing</h2>
      <p class="empty">The mutation run finished as ${escapeHtml(result.mutation.status)} and produced no evidence: ${escapeHtml(result.mutation.errorMessage ?? "no report")}</p>
    </section>`;
  }

  const criticalWarning =
    mutation.survivedCriticalMutants > 0
      ? `<p class="subtle"><span class="chip" data-status="critical">&#10005; ${String(mutation.survivedCriticalMutants)} survivor(s) in a critical area</span></p>`
      : "";

  const survivors = mutation.survivors
    .slice(0, 15)
    .map(
      (survivor) => `
        <tr>
          <td><code>${escapeHtml(survivor.file)}</code></td>
          <td>${String(survivor.line)}</td>
          <td>${escapeHtml(survivor.mutator)}</td>
          <td>${escapeHtml(survivor.status === "NO_COVERAGE" ? "not covered" : "survived")}</td>
          <td>${survivor.critical ? '<span class="chip" data-status="critical">critical</span>' : ""}</td>
        </tr>`
    )
    .join("");

  return `
    <section>
      <h2>Mutation testing</h2>
      <div class="tiles">
        <div class="tile">
          <p class="tile-label">Mutation score</p>
          <p class="tile-value">${String(mutation.mutationScore)}</p>
          <p class="tile-note">${String(mutation.filesAnalysed)} file(s) analysed</p>
        </div>
        <div class="tile">
          <p class="tile-label">Killed / survived</p>
          <p class="tile-value">${String(mutation.totals.killed)} / ${String(mutation.totals.survived)}</p>
          <p class="tile-note">${String(mutation.totals.noCoverage)} uncovered · ${String(mutation.totals.timeout)} timeout</p>
        </div>
      </div>
      ${criticalWarning}
      ${
        survivors === ""
          ? '<p class="empty">No mutant survived.</p>'
          : `<div class="scroll">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Line</th>
              <th scope="col">Mutator</th>
              <th scope="col">Status</th>
              <th scope="col">Area</th>
            </tr>
          </thead>
          <tbody>${survivors}</tbody>
        </table>
      </div>`
      }
    </section>`;
};

const renderChanges = (result: CheckResult): string => {
  const rows = result.repositoryAnalysis.changes
    .map(
      (change) => `
        <tr>
          <td><code>${escapeHtml(change.path)}</code></td>
          <td>${escapeHtml(change.type)}</td>
          <td>${escapeHtml(change.area)}</td>
          <td>${formatNumber(change.businessCriticality)}</td>
          <td>+${String(change.additions)} / -${String(change.deletions)}</td>
        </tr>`
    )
    .join("");

  return `
      <div class="scroll">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Change</th>
              <th scope="col">Area</th>
              <th scope="col">Criticality</th>
              <th scope="col">Lines</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
};

export const renderHtmlReport = (result: CheckResult): string => {
  const decision = DECISION_COPY[result.gate.decision];
  const heroGlyph =
    result.gate.decision === "RELEASE_APPROVED"
      ? "&#10003;"
      : result.gate.decision === "REVIEW_REQUIRED"
        ? "&#33;"
        : "&#10005;";

  const riskRows = result.risk.factors
    .map((factor) =>
      row(
        RISK_FACTOR_LABELS[factor.key] ?? factor.key,
        `${formatNumber(factor.contribution)} / ${String(factor.weight)}`,
        factor.contribution,
        factor.weight,
        factor.available ? undefined : "no evidence — conservative fallback"
      )
    )
    .join("");

  const qualityRows = result.quality.components
    .map((component) =>
      row(
        QUALITY_COMPONENT_LABELS[component.key] ?? component.key,
        `${formatNumber(component.contribution)} / ${String(component.weight)}`,
        component.contribution,
        component.weight,
        component.available ? undefined : "no evidence"
      )
    )
    .join("");

  const brokenBanner = result.executionBroken
    ? `
    <section>
      <h2>Warning</h2>
      <p class="empty">At least one suite did not finish in a usable way (crash or timeout). The decision below must not be treated as release evidence.</p>
    </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence Gate — ${escapeHtml(result.projectName)}</title>
<style>${styles}</style>
</head>
<body>
<main>
  <header class="page-head">
    <p class="eyebrow">Evidence Gate</p>
    <h1>${escapeHtml(result.projectName)}</h1>
    <p class="subtle">${escapeHtml(result.diffSource)} · ${escapeHtml(result.generatedAt)} · policy ${escapeHtml(result.policyVersion)}</p>
  </header>

  <section>
    <div class="hero">
      <div class="hero-mark" data-status="${decision.status}" aria-hidden="true">${heroGlyph}</div>
      <div>
        <p class="hero-decision">${escapeHtml(decision.label)}</p>
        <span class="hero-code">${escapeHtml(result.gate.decision)}</span>
        <p>${escapeHtml(decision.summary)}</p>
      </div>
    </div>
  </section>
${brokenBanner}
  <section>
    <h2>Headline numbers</h2>
    <div class="tiles">
      <div class="tile">
        <p class="tile-label">Quality Score</p>
        <p class="tile-value">${String(result.quality.score)}</p>
        <p class="tile-note">85 approves · 65 requires review</p>
      </div>
      <div class="tile">
        <p class="tile-label">Risk Score</p>
        <p class="tile-value">${String(result.risk.score)}</p>
        <p class="tile-note">${escapeHtml(result.risk.level)} risk</p>
      </div>
      <div class="tile">
        <p class="tile-label">Evidence confidence</p>
        <p class="tile-value">${String(result.quality.confidence)}</p>
        <p class="tile-note">${String(result.quality.missingEvidence.length)} component${result.quality.missingEvidence.length === 1 ? "" : "s"} without evidence</p>
      </div>
    </div>
  </section>

  <section>
    <h2>Why this decision</h2>
    ${renderReasons(result.gate.reasons)}
  </section>

  <section>
    <h2>Contribution of each risk factor</h2>
    <table>
      <tbody>${riskRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Quality Score components</h2>
    <table>
      <tbody>${qualityRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Test execution</h2>
    <p class="subtle">${escapeHtml(result.selection.strategy)} — ${escapeHtml(result.selection.reason)}</p>
    ${renderExecutions(result)}
  </section>
${renderFailedTests(result)}${renderMutation(result)}
  <section>
    <h2>Analysed changes</h2>
    <p class="subtle">${String(result.repositoryAnalysis.changes.length)} file(s) · ${String(result.repositoryAnalysis.totalChangedLines)} line(s) · areas: ${escapeHtml(result.repositoryAnalysis.affectedAreas.join(", "))}</p>
    ${renderChanges(result)}
  </section>

  <footer>Generated by Evidence Gate. Nothing here is estimated: every number comes from the diff, the policy and a real test run.</footer>
</main>
</body>
</html>
`;
};
