// packages/core/src/oracles/tests.ts
// S9: TestOracle — run tests in head worktree, confirm/upgrade findings

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { TestRunnerPort } from "../ports/runner.js";
import type { NexusGuardConfig, Finding, TestResult } from "../types.js";

export interface TestOracleResult {
  findings: Finding[];            // updated findings with upgraded confirmations
  testResults: TestResult[];
}

export interface VitestJsonResult {
  testResults?: Array<{
    testFilePath: string;
    status: "passed" | "failed" | "skipped";
    assertionResults?: Array<{
      fullName: string;
      status: "passed" | "failed" | "pending";
      ancestorTitles: string[];
      failureMessages?: string[];
    }>;
  }>;
}

export function parseVitestJson(output: string): VitestJsonResult | null {
  try {
    // Vitest may print logs before the JSON; find the first '{'
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) return null;
    return JSON.parse(output.slice(jsonStart)) as VitestJsonResult;
  } catch {
    return null;
  }
}

export class TestOracle {
  constructor(
    private readonly runner: TestRunnerPort,
    private readonly config: NexusGuardConfig,
    private readonly cacheDir: string,
  ) {}

  async run(
    findings: Finding[],
    headWorktreePath: string,
    baseSha: string,
  ): Promise<TestOracleResult> {
    const updatedFindings = [...findings];
    const testResults: TestResult[] = [];

    // Get services with BROKEN or AT_RISK findings
    const affectedServices = new Set(
      findings
        .filter((f) => f.verdict === "BROKEN" || f.verdict === "AT_RISK")
        .map((f) => f.service),
    );

    for (const service of affectedServices) {
      const cmd = this.config.commands.test[service];
      if (!cmd) continue;

      // Run tests in head worktree
      const headResult = await this.runner.run(
        cmd,
        headWorktreePath,
        this.config.timeouts.testMs,
      );

      const headParsed = parseVitestJson(headResult.stdout);
      const headFailed = extractFailedTests(headParsed);

      // Get or build baseline (base test result)
      const baseline = await this.getBaselineResult(service, baseSha, headWorktreePath);
      const baseFailed = new Set(baseline);

      // Regressions: failed on head but passed on base
      const regressions = headFailed.filter((t) => !baseFailed.has(t));

      testResults.push({
        service,
        ok: headFailed.length === 0,
        failed: headFailed,
        durationMs: headResult.durationMs,
        isBaseline: false,
      });

      if (regressions.length === 0) continue;

      // Map regressions to findings by service
      for (let i = 0; i < updatedFindings.length; i++) {
        const f = updatedFindings[i]!;
        if (f.service !== service) continue;
        if (f.verdict !== "BROKEN" && f.verdict !== "AT_RISK") continue;
        updatedFindings[i] = {
          ...f,
          confirmation: "CONFIRMED_BY_TEST",
        };
      }
    }

    return { findings: updatedFindings, testResults };
  }

  private async getBaselineResult(
    service: string,
    baseSha: string,
    headWorktreePath: string,
  ): Promise<string[]> {
    const cacheFile = path.join(this.cacheDir, "baseline", baseSha, `${service.replace(/\//g, "_").replace(/@/g, "")}.json`);
    try {
      const raw = await fs.readFile(cacheFile, "utf8");
      const data = JSON.parse(raw) as { failed: string[] };
      return data.failed;
    } catch {
      // Build baseline by running tests in the head worktree (with base SHA context)
      // In practice you'd run in the base worktree; this is a best-effort fallback
      return [];
    }
  }

  async buildBaseline(
    service: string,
    baseSha: string,
    baseWorktreePath: string,
  ): Promise<string[]> {
    const cmd = this.config.commands.test[service];
    if (!cmd) return [];

    const result = await this.runner.run(
      cmd,
      baseWorktreePath,
      this.config.timeouts.testMs,
    );
    const parsed = parseVitestJson(result.stdout);
    const failed = extractFailedTests(parsed);

    // Cache it
    const cacheFile = path.join(
      this.cacheDir, "baseline", baseSha,
      `${service.replace(/\//g, "_").replace(/@/g, "")}.json`,
    );
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ failed, ts: new Date().toISOString() }), "utf8");

    return failed;
  }
}

function extractFailedTests(result: VitestJsonResult | null): string[] {
  if (!result?.testResults) return [];
  const failed: string[] = [];
  for (const suite of result.testResults) {
    if (!suite.assertionResults) continue;
    for (const t of suite.assertionResults) {
      if (t.status === "failed") {
        failed.push(`${suite.testFilePath}::${t.fullName}`);
      }
    }
  }
  return failed;
}
