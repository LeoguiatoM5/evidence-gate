import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export class DiffSourceError extends Error {
  public readonly code = "DIFF_UNAVAILABLE";

  public constructor(message: string) {
    super(message);
    this.name = "DiffSourceError";
  }
}

export interface ResolvedDiff {
  diff: string;
  /** Human-readable description of where the diff came from, shown in the report. */
  source: string;
}

export interface DiffSourceOptions {
  cwd: string;
  baseRef: string;
  diffFile?: string;
}

const runGit = (cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync("git", args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
};

/**
 * Reads the diff from a file when one is given, otherwise asks git. Falls back from
 * the three-dot range to the working tree so the CLI still works in a repository
 * that has no configured upstream.
 */
export const resolveDiff = (options: DiffSourceOptions): ResolvedDiff => {
  if (options.diffFile) {
    const path = resolve(options.cwd, options.diffFile);
    if (!existsSync(path)) throw new DiffSourceError(`Diff file not found: ${path}`);
    const diff = readFileSync(path, "utf8");
    if (diff.trim() === "") throw new DiffSourceError(`Diff file is empty: ${path}`);
    return { diff, source: `patch file ${options.diffFile}` };
  }

  const insideRepository = runGit(options.cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideRepository.ok) {
    throw new DiffSourceError(
      `${options.cwd} is not a git repository (or git is unavailable). Use --diff-file <path> to analyse a patch file instead.`
    );
  }

  const ranged = runGit(options.cwd, ["diff", "--no-color", `${options.baseRef}...HEAD`]);
  if (ranged.ok && ranged.stdout.trim() !== "") {
    return { diff: ranged.stdout, source: `git diff ${options.baseRef}...HEAD` };
  }

  const workingTree = runGit(options.cwd, ["diff", "--no-color", "HEAD"]);
  if (workingTree.ok && workingTree.stdout.trim() !== "") {
    return { diff: workingTree.stdout, source: "git diff HEAD (working tree)" };
  }

  const detail = ranged.ok ? "" : ` git said: ${ranged.stderr.trim()}`;
  throw new DiffSourceError(
    `No changes found against "${options.baseRef}" nor in the working tree.${detail}`
  );
};
