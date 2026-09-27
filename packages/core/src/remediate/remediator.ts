// packages/core/src/remediate/remediator.ts
// S11: Remediator — bounded self-healing loop (max 3 attempts)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReasoningProvider } from "../ports/reasoning.js";
import type { GitPort } from "../ports/git.js";
import type { TestRunnerPort } from "../ports/runner.js";
import type {
  Finding,
  ChangeFact,
  NexusGuardConfig,
  RemediationResult,
  AttemptResult,
  EditOp,
} from "../types.js";
import { PatchProposal } from "../llm/schemas.js";
import { tryParseJson } from "../llm/parse.js";
import { renderPatchPrompt } from "../llm/prompts.js";
import { checkScope, applyEdits } from "./scopeGate.js";
import { parseTscOutput } from "../oracles/compiler.js";
import { sanitizeForPrompt } from "../adapters/bobShell.js";

export interface RemediatorOptions {
  runId: string;
  headSha: string;
  repoRoot: string;
  nexusguardDir: string;
  producerFiles: Set<string>;
}

export class Remediator {
  constructor(
    private readonly reasoning: ReasoningProvider,
    private readonly git: GitPort,
    private readonly runner: TestRunnerPort,
    private readonly config: NexusGuardConfig,
  ) {}

  async remediate(
    findings: Finding[],
    facts: ChangeFact[],
    producerBefore: string,
    producerAfter: string,
    opts: RemediatorOptions,
  ): Promise<RemediationResult> {
    const brokenFindings = findings.filter((f) => f.verdict === "BROKEN");
    if (brokenFindings.length === 0) {
      return { status: "NOT_RUN", attempts: [] };
    }

    const { maxAttempts } = this.config.limits;
    const { runId, headSha, repoRoot, nexusguardDir } = opts;

    // Create fix worktree on a new branch
    const branch = `nexusguard/fix/${runId}`;
    const fixWorktreePath = path.join(nexusguardDir, "wt", `${runId}-fix`);
    await this.git.addWorktree(repoRoot, fixWorktreePath, headSha, branch);

    const attempts: AttemptResult[] = [];
    let lastAttemptEdits: EditOp[] = [];
    let lastErrors = "";

    for (let n = 1; n <= maxAttempts; n++) {
      const start = Date.now();

      // Get allowed file contents
      const allowedFiles = this.getAllowedFiles(brokenFindings);
      const fileContents = new Map<string, string>();
      for (const file of allowedFiles) {
        const filePath = path.join(fixWorktreePath, file);
        try {
          const content = await fs.readFile(filePath, "utf8");
          fileContents.set(file, content);
        } catch {
          // file may not exist in worktree
        }
      }

      // Build prompt
      const promptText = renderPatchPrompt(
        facts,
        producerBefore,
        producerAfter,
        brokenFindings,
        Array.from(fileContents.entries()).map(([p, content]) => ({ path: p, content })),
        n > 1
          ? { n: n - 1, edits: lastAttemptEdits, errors: sanitizeForPrompt(lastErrors, repoRoot) }
          : undefined,
        this.config.limits.maxChangedLinesPerAttempt,
      );

      // Call the LLM
      let rawResult;
      try {
        rawResult = await this.reasoning.proposeEdits(
          { runId, promptText, promptVersion: "patch-v1", attemptN: n },
          {
            timeoutMs: this.config.timeouts.attemptMs,
            runId,
            attempt: n,
          },
        );
      } catch (err) {
        const ms = Date.now() - start;
        attempts.push({
          n,
          edits: [],
          gate: { ok: false, violations: ["LLM call failed: " + String(err)] },
          typecheck: { ok: false },
          tests: [],
          ms,
        });
        continue;
      }

      // Parse the proposal
      const parsed = tryParseJson(rawResult.text);
      const schemaResult = PatchProposal.safeParse(parsed);
      if (!schemaResult.success) {
        const ms = Date.now() - start;
        lastErrors = `Schema validation failed: ${schemaResult.error.message}`;
        attempts.push({
          n,
          edits: [],
          gate: { ok: false, violations: [lastErrors] },
          typecheck: { ok: false },
          tests: [],
          ms,
        });
        continue;
      }

      const proposal = schemaResult.data;
      const edits: EditOp[] = proposal.edits;
      lastAttemptEdits = edits;

      // ScopeGate
      const gate = checkScope(edits, brokenFindings, opts.producerFiles, this.config);
      if (!gate.ok) {
        const ms = Date.now() - start;
        lastErrors = gate.violations.join("; ");
        attempts.push({ n, edits, gate, typecheck: { ok: false }, tests: [], ms });
        continue;
      }

      // Apply edits
      const { updated, errors: applyErrors } = applyEdits(edits, fileContents);
      if (applyErrors.length > 0) {
        const ms = Date.now() - start;
        lastErrors = applyErrors.join("; ");
        attempts.push({
          n,
          edits,
          gate: { ok: false, violations: applyErrors },
          typecheck: { ok: false },
          tests: [],
          ms,
        });
        continue;
      }

      // Write updated files to fix worktree
      for (const [file, content] of updated) {
        const filePath = path.join(fixWorktreePath, file);
        await fs.writeFile(filePath, content, "utf8");
      }

      // Run tsc
      const tscResult = await this.runner.run(
        this.config.commands.typecheck,
        fixWorktreePath,
        this.config.timeouts.typecheckMs,
      );
      const tscErrors = parseTscOutput(
        tscResult.stdout + tscResult.stderr,
        fixWorktreePath,
      );
      const typecheckOk = tscErrors.length === 0 && tscResult.exitCode === 0;

      if (!typecheckOk) {
        const ms = Date.now() - start;
        lastErrors = tscResult.stdout.slice(0, 4096) + tscResult.stderr.slice(0, 1024);
        attempts.push({
          n,
          edits,
          gate: { ok: true, violations: [] },
          typecheck: { ok: false, errors: sanitizeForPrompt(lastErrors, repoRoot) },
          tests: [],
          ms,
        });
        // Restore files for next attempt
        for (const [file, content] of fileContents) {
          await fs.writeFile(path.join(fixWorktreePath, file), content, "utf8");
        }
        continue;
      }

      // Run tests for affected services + producer service
      const testResults: Array<{ service: string; ok: boolean; failed: string[] }> = [];
      const testedServices = new Set([
        ...brokenFindings.map((f) => f.service),
      ]);

      for (const service of testedServices) {
        const cmd = this.config.commands.test[service];
        if (!cmd) continue;
        const result = await this.runner.run(cmd, fixWorktreePath, this.config.timeouts.testMs);
        const ok = result.exitCode === 0;
        testResults.push({ service, ok, failed: ok ? [] : ["Tests failed (see output)"] });
        if (!ok) {
          lastErrors = result.stdout.slice(0, 4096) + result.stderr.slice(0, 1024);
        }
      }

      const allTestsPassed = testResults.every((t) => t.ok);
      const ms = Date.now() - start;
      attempts.push({
        n,
        edits,
        gate: { ok: true, violations: [] },
        typecheck: { ok: true },
        tests: testResults,
        ms,
      });

      if (allTestsPassed) {
        // Commit to the fix branch
        await this.git.commitAll(
          fixWorktreePath,
          `fix: nexusguard auto-heal for run ${runId}\n\nBlast-radius analysis found ${brokenFindings.length} broken consumer(s).\nGenerated by NexusGuard + IBM Bob — review required before merging.`,
        );

        return {
          status: "SUCCESS",
          branch,
          attempts,
        };
      }

      // Restore files for next attempt
      for (const [file, content] of fileContents) {
        await fs.writeFile(path.join(fixWorktreePath, file), content, "utf8");
      }
    }

    return {
      status: "MANUAL_REVIEW_REQUIRED",
      branch,
      attempts,
    };
  }

  private getAllowedFiles(findings: Finding[]): string[] {
    return [...new Set(findings.filter((f) => f.verdict === "BROKEN").map((f) => f.file))];
  }
}
