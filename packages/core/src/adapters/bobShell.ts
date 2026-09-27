// packages/core/src/adapters/bobShell.ts
// BobShellProvider — calls IBM Bob Shell non-interactively (Mode B)
// ⚠️ VERIFY: exact flags for non-interactive mode (Q1–Q3 from the hour-0 checklist)

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type {
  ReasoningProvider,
  ImpactRequest,
  PatchRequest,
  CallOptions,
  RawLLMResult,
} from "../ports/reasoning.js";

const BOB_BIN = process.env["BOB_BIN"] ?? "bob";
const BOB_API_KEY = process.env["BOB_API_KEY"] ?? "";

/** Extract the last ```json ... ``` fenced block from text. */
export function extractJsonFence(text: string): string | null {
  const pattern = /```json\s*([\s\S]*?)```/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    last = match[1]?.trim() ?? null;
  }
  return last;
}

/** Strip ANSI codes and absolute paths from error output before feeding it back as a prompt. */
export function sanitizeForPrompt(text: string, repoRoot: string): string {
  // Remove ANSI escape codes
  let s = text.replace(/\x1b\[[0-9;]*m/g, "");
  // Replace absolute paths with relative ones
  s = s.split(repoRoot).join("<repo>");
  s = s.split(os.homedir()).join("<home>");
  // Truncate to 4 KB
  if (s.length > 4096) {
    s = s.slice(0, 4096) + "\n... (truncated)";
  }
  return s;
}

export class BobShellProvider implements ReasoningProvider {
  readonly id = "bob-shell" as const;

  private consecutiveTimeouts = 0;
  private readonly MAX_CONSECUTIVE_TIMEOUTS = 2;

  async analyzeImpact(req: ImpactRequest, opts: CallOptions): Promise<RawLLMResult> {
    return this.call(req.promptText, opts, "impact");
  }

  async proposeEdits(req: PatchRequest, opts: CallOptions): Promise<RawLLMResult> {
    return this.call(req.promptText, opts, "patch");
  }

  private async call(
    promptText: string,
    opts: CallOptions,
    _kind: string,
  ): Promise<RawLLMResult> {
    if (this.consecutiveTimeouts >= this.MAX_CONSECUTIVE_TIMEOUTS) {
      throw new Error(
        "BobShellProvider: circuit breaker open — too many consecutive timeouts",
      );
    }

    // Write prompt to a temp file so we don't expose it via process args
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexusguard-"));
    const promptFile = path.join(tmpDir, "prompt.txt");
    await fs.writeFile(promptFile, promptText, "utf8");

    const start = Date.now();

    try {
      const result = await this.spawnBob(promptFile, opts);
      if (result.timedOut) {
        this.consecutiveTimeouts++;
        throw new Error("BobShellProvider: request timed out");
      }
      this.consecutiveTimeouts = 0;
      return {
        text: result.stdout,
        latencyMs: Date.now() - start,
        promptChars: promptText.length,
        outputChars: result.stdout.length,
        provider: "bob-shell",
        cached: false,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private spawnBob(
    promptFile: string,
    opts: CallOptions,
  ): Promise<{ stdout: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      // ⚠️ VERIFY (Q1–Q3): adjust flags after hour-0 checklist
      // Documented flags: --print (non-interactive), --auth-method api-key
      const args = [
        "--print",                       // non-interactive, print to stdout
        "--auth-method", "api-key",
        "--mode", "ask",                 // read-only Ask mode (Q2)
        "--prompt-file", promptFile,
      ];

      const child = spawn(BOB_BIN, args, {
        shell: false,
        env: {
          PATH: process.env["PATH"] ?? "",
          BOB_API_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      const MAX = 256 * 1024; // 256 KB cap

      child.stdout.on("data", (c: Buffer) => {
        if (chunks.reduce((a, b) => a + b.length, 0) < MAX) chunks.push(c);
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, opts.timeoutMs);

      child.on("close", () => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(chunks).toString("utf8"), timedOut });
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve({ stdout: "", timedOut: false });
      });

      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          child.kill("SIGTERM");
        });
      }
    });
  }
}
