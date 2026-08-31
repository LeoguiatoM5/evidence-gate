import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { GitChange, GitChangeType, RepositoryAnalysis } from "@evidence-gate/core";

export interface CriticalityRule {
  pathPrefix: string;
  area: string;
  businessCriticality: number;
}

interface MutableChange {
  path: string;
  oldPath: string | null;
  type: GitChangeType;
  additions: number;
  deletions: number;
  inHunk: boolean;
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

const inferArea = (path: string): string => {
  const segments = normalizePath(path).split("/").filter(Boolean);
  if (segments.length === 0) return "root";
  if (segments[0] === "src" && segments[1]) return segments[1];
  if ((segments[0] === "apps" || segments[0] === "packages") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? "root";
};

const resolveClassification = (
  path: string,
  rules: readonly CriticalityRule[]
): { area: string; businessCriticality: number } => {
  const normalized = normalizePath(path);
  const matches = rules
    .filter((rule) => normalized.startsWith(normalizePath(rule.pathPrefix)))
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);
  const match = matches[0];
  return match
    ? { area: match.area, businessCriticality: match.businessCriticality }
    : { area: inferArea(normalized), businessCriticality: 50 };
};

const sanitizeDiffPath = (value: string): string => {
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return normalizePath(unquoted.replace(/^[ab]\//, ""));
};

export const analyzeGitDiff = (
  diff: string,
  rules: readonly CriticalityRule[] = []
): RepositoryAnalysis => {
  const changes: GitChange[] = [];
  let current: MutableChange | null = null;

  const flush = (): void => {
    if (!current) return;
    const classification = resolveClassification(current.path, rules);
    const extension = extname(current.path).toLowerCase();
    changes.push({
      path: current.path,
      oldPath: current.oldPath,
      type: current.type,
      additions: current.additions,
      deletions: current.deletions,
      extension: extension || null,
      area: classification.area,
      businessCriticality: classification.businessCriticality
    });
    current = null;
  };

  for (const line of diff.replaceAll("\r\n", "\n").split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      current = {
        oldPath: sanitizeDiffPath(header[1] ?? ""),
        path: sanitizeDiffPath(header[2] ?? ""),
        type: "MODIFIED",
        additions: 0,
        deletions: 0,
        inHunk: false
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("new file mode ")) current.type = "ADDED";
    else if (line.startsWith("deleted file mode ")) current.type = "DELETED";
    else if (line.startsWith("rename from ")) {
      current.type = "RENAMED";
      current.oldPath = sanitizeDiffPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.type = "RENAMED";
      current.path = sanitizeDiffPath(line.slice("rename to ".length));
    } else if (line.startsWith("@@")) current.inHunk = true;
    else if (current.inHunk && line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    else if (current.inHunk && line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }

  flush();

  if (changes.length === 0) {
    throw new Error("The supplied Git diff does not contain any supported file changes.");
  }

  const totalAdditions = changes.reduce((total, change) => total + change.additions, 0);
  const totalDeletions = changes.reduce((total, change) => total + change.deletions, 0);

  return {
    diffHash: createHash("sha256").update(diff).digest("hex"),
    changes,
    affectedAreas: [...new Set(changes.map((change) => change.area))].sort(),
    totalAdditions,
    totalDeletions,
    totalChangedLines: totalAdditions + totalDeletions
  };
};
