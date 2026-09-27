// packages/core/src/adapters/nodeRunner.ts
// TestRunnerPort implementation using Node child_process

import { spawn } from "node:child_process";
import type { TestRunnerPort, RunResult } from "../ports/runner.js";

export class NodeRunnerAdapter implements TestRunnerPort {
  async run(
    cmd: string[],
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<RunResult> {
    const [executable, ...args] = cmd;
    if (!executable) throw new Error("Empty command");

    const start = Date.now();
    let timedOut = false;

    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        env: {
          PATH: process.env["PATH"] ?? "",
          NODE_ENV: "test",
          CI: "1",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const MAX_BUF = 1 * 1024 * 1024; // 1 MB

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutChunks.reduce((a, b) => a + b.length, 0) < MAX_BUF) {
          stdoutChunks.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrChunks.reduce((a, b) => a + b.length, 0) < MAX_BUF) {
          stderrChunks.push(chunk);
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeoutMs);

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          durationMs: Date.now() - start,
          timedOut,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: err.message,
          durationMs: Date.now() - start,
          timedOut: false,
        });
      });
    });
  }
}
