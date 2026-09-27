// packages/core/src/oracles/compiler.ts
// S5: CompilerOracle — deterministic findings from tsc

import type { TestRunnerPort } from "../ports/runner.js";
import type { CompilerFinding, NexusGuardConfig } from "../types.js";
import * as path from "node:path";

export interface CompilerOracleResult {
  findings: CompilerFinding[];
  rawOutput: string;
  durationMs: number;
  timedOut: boolean;
  baseErrors: Set<string>;   // pre-existing errors (file:line:code)
}

/**
 * Parse tsc --pretty false output into CompilerFinding[].
 * Format: path/to/file.ts(line,col): error TSxxxx: message
 */
export function parseTscOutput(output: string, repoRoot: string): CompilerFinding[] {
  const findings: CompilerFinding[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(output)) !== null) {
    const rawFile = m[1] ?? "";
    const file = rawFile.split(repoRoot).join("").replace(/^[\\/]/, "").split("\\").join("/");
    findings.push({
      file,
      line: parseInt(m[2] ?? "0", 10),
      col: parseInt(m[3] ?? "0", 10),
      code: m[4] ?? "",
      message: m[5]?.trim() ?? "",
      isNew: true,
    });
  }
  return findings;
}

export class CompilerOracle {
  constructor(
    private readonly runner: TestRunnerPort,
    private readonly config: NexusGuardConfig,
  ) {}

  async run(
    worktreePath: string,
    changedFiles: Set<string>,
    baseErrors: Set<string>,
  ): Promise<CompilerOracleResult> {
    const cmd = this.config.commands.typecheck;
    const result = await this.runner.run(
      cmd,
      worktreePath,
      this.config.timeouts.typecheckMs,
    );

    const allFindings = parseTscOutput(result.stdout + result.stderr, worktreePath);

    // Keep only errors in files NOT changed by the diff
    // and that are not pre-existing (not in base error set)
    const newFindings: CompilerFinding[] = [];
    for (const f of allFindings) {
      if (changedFiles.has(f.file)) continue;
      const key = `${f.file}:${f.line}:${f.code}`;
      if (baseErrors.has(key)) continue;
      newFindings.push({ ...f, isNew: true });
    }

    return {
      findings: newFindings,
      rawOutput: result.stdout + result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      baseErrors,
    };
  }

  async buildBaseErrorSet(
    baseWorktreePath: string,
  ): Promise<Set<string>> {
    const cmd = this.config.commands.typecheck;
    const result = await this.runner.run(
      cmd,
      baseWorktreePath,
      this.config.timeouts.typecheckMs,
    );
    const findings = parseTscOutput(result.stdout + result.stderr, baseWorktreePath);
    return new Set(findings.map((f) => `${f.file}:${f.line}:${f.code}`));
  }
}
