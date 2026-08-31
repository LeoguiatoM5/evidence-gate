import { spawn } from "node:child_process";

export interface ProcessRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  output: string;
  durationMs: number;
  spawnError: string | null;
}

/** Collects output up to a hard byte budget while still draining the stream. */
class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  public truncated = false;

  public constructor(private readonly maxBytes: number) {}

  public append(chunk: Buffer): void {
    if (this.size >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.maxBytes;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  public toString(): string {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? `${text}\n[output truncated by Evidence Gate execution policy]` : text;
  }
}

const killProcessTree = (pid: number): void => {
  if (process.platform === "win32") {
    // Node only signals the direct child on Windows; taskkill terminates the tree.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
};

/**
 * Runs an allow-listed command with no shell interpretation, a hard timeout and a
 * bounded amount of captured output.
 */
export const runProcess = (request: ProcessRunRequest): Promise<ProcessRunResult> =>
  new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const output = new BoundedOutput(request.maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
    }, request.timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.append(chunk));

    const settle = (result: Omit<ProcessRunResult, "durationMs" | "truncated" | "output">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ...result,
        truncated: output.truncated,
        output: output.toString(),
        durationMs: Date.now() - startedAt
      });
    };

    child.on("error", (error: Error) => {
      settle({ exitCode: null, signal: null, timedOut, spawnError: error.message });
    });

    child.on("close", (code, signal) => {
      settle({ exitCode: code, signal, timedOut, spawnError: null });
    });
  });
