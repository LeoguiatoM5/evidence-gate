import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadCheckConfig } from "./config.js";
import { DiffSourceError, resolveDiff } from "./diff-source.js";
import { renderHtmlReport } from "./report-html.js";
import { renderMarkdownReport } from "./report-markdown.js";
import { renderTerminalReport } from "./report-terminal.js";
import { runCheck } from "./run-check.js";

const USAGE = `
evidence-gate check — decides whether a change is safe to release.

Usage:
  evidence-gate check [options]

Options:
  --cwd <dir>          project directory to evaluate (default: current directory)
  --config <file>      configuration file (default: evidence-gate.config.json)
  --diff-file <file>   analyse a patch file instead of asking git
  --base <ref>         comparison ref (default: baseRef from the configuration)
  --report <file>      HTML report destination (default: evidence-gate-report.html)
  --no-report          do not write the HTML report
  --json               print the full result as JSON
  --summary <file>     write a Markdown summary (pull request comment, CI summary)
  --output-json <file> write the full result as JSON to a file
  --fail-on <level>    blocked | review (default: review)
  --help               show this help

Exit codes:
  0  the decision is within what --fail-on allows
  1  the gate rejected the change
  2  operational error (configuration, diff or execution)
`;

interface ParsedArguments {
  command: string;
  cwd: string;
  config?: string;
  diffFile?: string;
  base?: string;
  report?: string;
  summary?: string;
  outputJson?: string;
  writeReport: boolean;
  json: boolean;
  failOn: "blocked" | "review";
  help: boolean;
}

export const parseArguments = (argv: readonly string[]): ParsedArguments => {
  const parsed: ParsedArguments = {
    command: "check",
    cwd: process.cwd(),
    writeReport: true,
    json: false,
    failOn: "review",
    help: false
  };

  const rest = [...argv];
  if (rest[0] !== undefined && !rest[0].startsWith("--")) {
    parsed.command = rest.shift() ?? "check";
  }

  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === undefined) break;
    const readValue = (name: string): string => {
      const value = rest.shift();
      if (value === undefined) throw new Error(`Option ${name} requires a value.`);
      return value;
    };

    switch (flag) {
      case "--cwd":
        parsed.cwd = resolve(readValue(flag));
        break;
      case "--config":
        parsed.config = readValue(flag);
        break;
      case "--diff-file":
        parsed.diffFile = readValue(flag);
        break;
      case "--base":
        parsed.base = readValue(flag);
        break;
      case "--report":
        parsed.report = readValue(flag);
        break;
      case "--summary":
        parsed.summary = readValue(flag);
        break;
      case "--output-json":
        parsed.outputJson = readValue(flag);
        break;
      case "--no-report":
        parsed.writeReport = false;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--fail-on": {
        const value = readValue(flag);
        if (value !== "blocked" && value !== "review") {
          throw new Error('--fail-on accepts only "blocked" or "review".');
        }
        parsed.failOn = value;
        break;
      }
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return parsed;
};

const EXIT_OK = 0;
const EXIT_GATE_FAILED = 1;
const EXIT_OPERATIONAL = 2;

export const main = async (argv: readonly string[]): Promise<number> => {
  let options: ParsedArguments;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return EXIT_OPERATIONAL;
  }

  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (options.command !== "check") {
    console.error(`Unknown command: ${options.command}`);
    console.error(USAGE);
    return EXIT_OPERATIONAL;
  }

  try {
    const config = loadCheckConfig({
      cwd: options.cwd,
      configPath: options.config,
      reportPath: options.report
    });
    const diff = resolveDiff({
      cwd: options.cwd,
      baseRef: options.base ?? config.baseRef,
      diffFile: options.diffFile
    });

    const result = await runCheck({
      config,
      diff: diff.diff,
      diffSource: diff.source,
      onStage: options.json
        ? undefined
        : (stage, detail) => {
            console.error(`  ${stage.padEnd(16, " ")} ${detail}`);
          }
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderTerminalReport(result));
    }

    if (options.writeReport) {
      writeFileSync(config.reportPath, renderHtmlReport(result), "utf8");
      if (!options.json) {
        console.log(`  Report: ${relative(options.cwd, config.reportPath) || config.reportPath}\n`);
      }
    }

    if (options.summary) {
      writeFileSync(
        resolve(options.cwd, options.summary),
        renderMarkdownReport(result, { commitSha: process.env.GITHUB_SHA }),
        "utf8"
      );
    }

    if (options.outputJson) {
      writeFileSync(
        resolve(options.cwd, options.outputJson),
        JSON.stringify(result, null, 2),
        "utf8"
      );
    }

    if (result.executionBroken) return EXIT_OPERATIONAL;
    if (result.gate.decision === "RELEASE_BLOCKED") return EXIT_GATE_FAILED;
    if (result.gate.decision === "REVIEW_REQUIRED" && options.failOn === "review") {
      return EXIT_GATE_FAILED;
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof DiffSourceError) {
      console.error(`\n  ${error.message}\n`);
      return EXIT_OPERATIONAL;
    }
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_OPERATIONAL;
  }
};
