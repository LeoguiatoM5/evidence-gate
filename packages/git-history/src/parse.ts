/**
 * Pure parsing of `git log` output. Kept separate from the process call so the
 * interpretation of a repository's history is testable without a repository.
 */

export interface HistoryCommit {
  sha: string;
  subject: string;
  files: string[];
  fix: boolean;
}

export const COMMIT_MARKER = "COMMIT";

/**
 * A commit counts as a fix when it says so. Conventional Commits are the strong
 * signal; the keyword list is the fallback, in English and Portuguese, and is
 * deliberately narrow — "refactor" and "fixture" must not count as bug fixes.
 */
const CONVENTIONAL_FIX = /^\s*(fix|bugfix|hotfix|patch)(\([^)]*\))?!?\s*:/i;

const FIX_KEYWORDS = [
  /\bfix(es|ed)?\b/i,
  /\bbugs?\b/i,
  /\bhotfix\b/i,
  /\bregress(ion|ão|ao)\b/i,
  /\bcorrig(e|ir|ido|indo)\b/i,
  /\bcorre[çc][ãa]o\b/i,
  /\bconserta(r|do)?\b/i,
  /\bresolve[sd]?\b/i
];

export const isFixSubject = (subject: string): boolean => {
  if (CONVENTIONAL_FIX.test(subject)) return true;
  // A conventional commit that declares another type is taken at its word.
  if (/^\s*(feat|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?\s*:/i.test(subject)) {
    return false;
  }
  return FIX_KEYWORDS.some((pattern) => pattern.test(subject));
};

const normalisePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

/**
 * Parses the output of
 * `git log --name-only --pretty=format:<COMMIT_MARKER>%H<TAB>%s`.
 */
export const parseGitLog = (output: string): HistoryCommit[] => {
  const commits: HistoryCommit[] = [];
  let current: HistoryCommit | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith(COMMIT_MARKER)) {
      if (current) commits.push(current);
      const [sha = "", ...subjectParts] = line.slice(COMMIT_MARKER.length).split("\t");
      const subject = subjectParts.join("\t");
      current = { sha, subject, files: [], fix: isFixSubject(subject) };
      continue;
    }

    if (line.trim() === "" || !current) continue;
    current.files.push(normalisePath(line.trim()));
  }

  if (current) commits.push(current);
  return commits;
};

export interface PathHistory {
  /** Commits touching the path inside the window. */
  changes: number;
  /** Commits touching the path whose message declares a fix. */
  fixes: number;
}

export const summariseByPath = (commits: readonly HistoryCommit[]): Map<string, PathHistory> => {
  const summary = new Map<string, PathHistory>();

  for (const commit of commits) {
    // A commit touching the same path twice still counts once.
    for (const file of new Set(commit.files)) {
      const entry = summary.get(file) ?? { changes: 0, fixes: 0 };
      entry.changes += 1;
      if (commit.fix) entry.fixes += 1;
      summary.set(file, entry);
    }
  }

  return summary;
};
