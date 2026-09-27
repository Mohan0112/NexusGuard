// packages/core/src/ports/runner.ts
// TestRunnerPort — runs allowlisted shell commands (tsc, vitest) in worktrees

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface TestRunnerPort {
  /** Run a command (no shell) in the given cwd. Returns RunResult. */
  run(
    cmd: string[],
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<RunResult>;
}
