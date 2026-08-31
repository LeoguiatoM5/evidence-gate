import type {
  MutantStatus,
  MutantTotals,
  MutationReport,
  SurvivedMutant
} from "@evidence-gate/core";
import { calculateMutationScore, emptyMutantTotals } from "@evidence-gate/core";
import { TestReportError } from "./report.js";

/**
 * Parser for the mutation-testing report schema, which StrykerJS emits with its
 * `json` reporter. The report comes from an external process, so every field is
 * treated as untrusted and optional.
 */

const STATUS_BY_NAME: Record<string, MutantStatus> = {
  killed: "KILLED",
  survived: "SURVIVED",
  timeout: "TIMEOUT",
  nocoverage: "NO_COVERAGE",
  compileerror: "COMPILE_ERROR",
  runtimeerror: "RUNTIME_ERROR",
  ignored: "IGNORED"
};

const TOTALS_KEY: Record<MutantStatus, keyof MutantTotals> = {
  KILLED: "killed",
  SURVIVED: "survived",
  TIMEOUT: "timeout",
  NO_COVERAGE: "noCoverage",
  COMPILE_ERROR: "compileError",
  RUNTIME_ERROR: "runtimeError",
  IGNORED: "ignored"
};

const MAXIMUM_SURVIVORS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const normalisePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

const readStatus = (value: unknown): MutantStatus | null => {
  const name = asString(value);
  if (!name) return null;
  return STATUS_BY_NAME[name.toLowerCase().replaceAll(/[\s_-]/g, "")] ?? null;
};

const readLine = (mutant: Record<string, unknown>): number => {
  const location = mutant.location;
  if (!isRecord(location)) return 0;
  const start = location.start;
  if (!isRecord(start)) return 0;
  return typeof start.line === "number" && Number.isFinite(start.line) ? start.line : 0;
};

export interface StrykerParseOptions {
  /** Path prefixes the project declared critical, already relative and posix-style. */
  criticalPathPrefixes: readonly string[];
}

const isCritical = (file: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => file.startsWith(normalisePath(prefix)));

export const parseStrykerReport = (
  raw: unknown,
  options: StrykerParseOptions
): MutationReport => {
  if (!isRecord(raw)) {
    throw new TestReportError("The mutation report is not a JSON object.");
  }
  if (!isRecord(raw.files)) {
    throw new TestReportError("The mutation report does not contain a files object.");
  }

  const totals = emptyMutantTotals();
  const survivors: SurvivedMutant[] = [];
  let survivedCriticalMutants = 0;
  let filesAnalysed = 0;

  for (const [rawPath, fileEntry] of Object.entries(raw.files)) {
    if (!isRecord(fileEntry)) continue;
    const mutants = fileEntry.mutants;
    if (!Array.isArray(mutants)) continue;

    filesAnalysed += 1;
    const file = normalisePath(rawPath);
    const critical = isCritical(file, options.criticalPathPrefixes);

    for (const rawMutant of mutants) {
      if (!isRecord(rawMutant)) continue;
      const status = readStatus(rawMutant.status);
      if (!status) continue;

      totals[TOTALS_KEY[status]] += 1;

      if (status === "SURVIVED" || status === "NO_COVERAGE") {
        // Only a survivor counts towards the critical blocker; a mutant that no test
        // covers is reported too, but it is a different problem and is not conflated.
        if (status === "SURVIVED" && critical) survivedCriticalMutants += 1;
        if (survivors.length < MAXIMUM_SURVIVORS) {
          survivors.push({
            file,
            mutator: asString(rawMutant.mutatorName) ?? "unknown",
            line: readLine(rawMutant),
            critical,
            status
          });
        }
      }
    }
  }

  return {
    mutationScore: calculateMutationScore(totals),
    totals,
    survivedCriticalMutants,
    survivors,
    filesAnalysed
  };
};
