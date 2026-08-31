/**
 * Mutation testing evidence. The domain knows nothing about StrykerJS: it knows
 * that some adapter can report how many mutants survived, and where.
 */

export const MUTANT_STATUSES = [
  "KILLED",
  "SURVIVED",
  "TIMEOUT",
  "NO_COVERAGE",
  "COMPILE_ERROR",
  "RUNTIME_ERROR",
  "IGNORED"
] as const;
export type MutantStatus = (typeof MUTANT_STATUSES)[number];

export interface MutantTotals {
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  compileError: number;
  runtimeError: number;
  ignored: number;
}

export interface SurvivedMutant {
  file: string;
  mutator: string;
  line: number;
  /** True when the file matches an area the project declared business critical. */
  critical: boolean;
  status: Extract<MutantStatus, "SURVIVED" | "NO_COVERAGE">;
}

export interface MutationReport {
  /**
   * Detected / valid × 100, where detected = killed + timeout and
   * valid = detected + survived + noCoverage. This is the standard definition;
   * mutants that never compiled or were ignored are excluded from both sides.
   */
  mutationScore: number;
  totals: MutantTotals;
  /** Mutants that survived in an area the project declared critical. */
  survivedCriticalMutants: number;
  survivors: SurvivedMutant[];
  filesAnalysed: number;
}

export interface MutationExecutionReport {
  status: "COMPLETED" | "FAILED" | "TIMED_OUT";
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  errorMessage: string | null;
  /** Null whenever the run did not produce a usable report. */
  mutation: MutationReport | null;
  artifacts: { type: string; path: string; sizeBytes: number }[];
}

export interface MutationRunRequest {
  analysisId: string;
  /** Paths the project declared critical, used to classify survivors. */
  criticalPathPrefixes: string[];
}

/** Port implemented by mutation adapters such as the StrykerJS runner. */
export interface MutationRunnerPort {
  readonly name: string;
  run(request: MutationRunRequest): Promise<MutationExecutionReport>;
}

export const emptyMutantTotals = (): MutantTotals => ({
  killed: 0,
  survived: 0,
  timeout: 0,
  noCoverage: 0,
  compileError: 0,
  runtimeError: 0,
  ignored: 0
});

/** Detected over valid, as defined by the mutation-testing report schema. */
export const calculateMutationScore = (totals: MutantTotals): number => {
  const detected = totals.killed + totals.timeout;
  const valid = detected + totals.survived + totals.noCoverage;
  if (valid === 0) return 0;
  return Number(((detected / valid) * 100).toFixed(2));
};
