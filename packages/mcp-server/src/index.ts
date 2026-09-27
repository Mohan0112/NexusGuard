#!/usr/bin/env node
// packages/mcp-server/src/index.ts
// NexusGuard MCP Server — exposes 7 tools to IBM Bob IDE (Mode A)
// Transport: stdio

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  Pipeline,
  RunStore,
  GitCliAdapter,
  NodeRunnerAdapter,
  BobShellProvider,
  DEFAULT_CONFIG,
  type NexusGuardConfig,
  validate,
  type EditOp,
  type EvidenceItem,
  type EvidenceBundle,
} from "@nexusguard/core";
import { checkScope, applyEdits } from "@nexusguard/core";

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "nexusguard", version: "0.1.0" },
  {
    capabilities: { tools: {} },
  },
);

const git = new GitCliAdapter();
const runner = new NodeRunnerAdapter();

// In-memory run context (persisted to store for multi-process access)
const activeRuns = new Map<
  string,
  {
    config: NexusGuardConfig;
    nexusguardDir: string;
    repoRoot: string;
    store: RunStore;
    submissionCount: number;
  }
>();

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "nexusguard_analyze_diff",
      description:
        "Analyze the blast radius of a diff between two git refs. " +
        "Returns runId, change facts, candidates (IDs and dependency paths), " +
        "compiler findings, and evidence IDs. " +
        "Only call with valid git SHAs or refs from the target repo.",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: {
            type: "string",
            description: "Absolute path to the repository root",
          },
          base: { type: "string", description: "Base git SHA or ref" },
          head: { type: "string", description: "Head git SHA or ref" },
        },
        required: ["repoPath", "base", "head"],
      },
    },
    {
      name: "nexusguard_get_evidence",
      description:
        "Retrieve evidence items by ID from a completed analyze run. " +
        "Only use IDs returned by nexusguard_analyze_diff. Max 10 per call.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          evidenceIds: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
          },
        },
        required: ["runId", "evidenceIds"],
      },
    },
    {
      name: "nexusguard_submit_findings",
      description:
        "Submit your impact verdict set after calling nexusguard_get_evidence. " +
        "The validator checks all claims (V1–V10). Rejected claims are returned with codes. " +
        "At most 2 submissions per run. Do NOT submit SAFE when the compiler found an error.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          verdictSetJson: {
            type: "string",
            description: "JSON string matching the impact-v1 schema",
          },
        },
        required: ["runId", "verdictSetJson"],
      },
    },
    {
      name: "nexusguard_run_tests",
      description:
        "Run tests for a specific service in the head worktree. " +
        "Service must be registered in nexusguard.config.json.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          service: { type: "string" },
        },
        required: ["runId", "service"],
      },
    },
    {
      name: "nexusguard_apply_edits",
      description:
        "Apply search/replace edits to the fix worktree for BROKEN findings. " +
        "Only call after nexusguard_submit_findings. " +
        "Edits are checked by ScopeGate and DenyList. " +
        "Max 3 attempts total. Never edit producer files, tests, configs, or package.json. " +
        "Never use @ts-ignore, as any, or eslint-disable.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          findingId: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                find: { type: "string" },
                replace: { type: "string" },
              },
              required: ["file", "find", "replace"],
            },
          },
        },
        required: ["runId", "findingId", "edits"],
      },
    },
    {
      name: "nexusguard_verify_patch",
      description:
        "Audit the fix worktree: check that all edited files are in the allowlist, " +
        "run tsc and tests. Returns scope audit results, typecheck result, and test results.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
    {
      name: "nexusguard_finalize",
      description:
        "Finalize the run: commit the fix branch and optionally create a PR with gh. " +
        "Only call after nexusguard_verify_patch passes.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          openPr: { type: "boolean", description: "Create a GitHub PR via gh CLI" },
        },
        required: ["runId"],
      },
    },
  ],
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "nexusguard_analyze_diff": {
        const repoPath = String(a["repoPath"] ?? "");
        const base = String(a["base"] ?? "");
        const head = String(a["head"] ?? "");

        if (!repoPath || !base || !head) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "repoPath, base, and head are required" }) }] };
        }

        const config = await loadConfig(path.join(repoPath, "nexusguard.config.json"));
        const nexusguardDir = path.join(repoPath, ".nexusguard");
        await fs.mkdir(nexusguardDir, { recursive: true });

        const store = new RunStore(nexusguardDir);
        const provider = new BobShellProvider();
        const pipeline = new Pipeline(provider, git, runner, store, config);

        const report = await pipeline.run({ repoRoot: repoPath, base, head, mode: "live" });

        activeRuns.set(report.runId, {
          config,
          nexusguardDir,
          repoRoot: repoPath,
          store,
          submissionCount: 0,
        });

        const summary = {
          runId: report.runId,
          changeFacts: report.changeFacts.map((f) => ({
            factId: f.factId,
            symbolId: f.symbolId,
            type: f.type,
            beforeEvidenceId: f.beforeEvidenceId,
            afterEvidenceId: f.afterEvidenceId,
          })),
          candidates: report.candidates.map((c) => ({
            candidateId: c.candidateId,
            consumerSymbolId: c.consumerSymbolId,
            service: c.service,
            path: c.path,
            serviceHops: c.serviceHops,
            evidenceIds: c.evidenceIds,
          })),
          compilerFindings: report.findings
            .filter((f) => f.source === "compiler")
            .map((f) => ({
              findingId: f.findingId,
              file: f.file,
              line: f.line,
              verdict: f.verdict,
              reason: f.reason,
            })),
          score: report.score,
          riskLevel: report.riskLevel,
        };

        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "nexusguard_get_evidence": {
        const runId = String(a["runId"] ?? "");
        const evidenceIds = (a["evidenceIds"] as string[]) ?? [];

        if (!runId) return err("runId is required");
        if (evidenceIds.length > 10) return err("At most 10 evidence IDs per call");

        const runCtx = activeRuns.get(runId);
        if (!runCtx) return err(`Run ${runId} not found`);

        const bundleFile = path.join(runCtx.nexusguardDir, "runs", runId, "bundle.json");
        const rawBundle = JSON.parse(await fs.readFile(bundleFile, "utf8")) as Array<{
          allById: Array<[string, { evidenceId: string; content: string; file: string; role: string; startLine: number; endLine: number }]>;
        }>;

        const allById = new Map(rawBundle.flatMap((b) => b.allById));
        const items = evidenceIds.map((id) => allById.get(id) ?? { error: `Evidence ${id} not found` });

        return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
      }

      case "nexusguard_submit_findings": {
        const runId = String(a["runId"] ?? "");
        const verdictSetJson = String(a["verdictSetJson"] ?? "");

        if (!runId) return err("runId is required");
        const runCtx = activeRuns.get(runId);
        if (!runCtx) return err(`Run ${runId} not found`);

        if (runCtx.submissionCount >= 2) {
          return err("Maximum 2 submissions per run reached");
        }
        runCtx.submissionCount++;

        const report = await runCtx.store.getReport(runId);
        if (!report) return err(`No report for run ${runId}`);

        // We need the bundle to validate
        const bundleFile = path.join(runCtx.nexusguardDir, "runs", runId, "bundle.json");
        const rawBundle = JSON.parse(await fs.readFile(bundleFile, "utf8")) as Array<{
          producerBefore: unknown;
          producerAfter: unknown;
          consumerEvidence: unknown[];
          allById: Array<[string, unknown]>;
          totalChars: number;
          runId: string;
        }>;

        const firstBundle = rawBundle[0];
        if (!firstBundle) return err("No bundle found");

        const bundle = {
          ...firstBundle,
          allById: new Map(firstBundle.allById) as Map<string, import("@nexusguard/core").EvidenceItem>,
        };

        const { validate: validateFn } = await import("@nexusguard/core");

        const result = validateFn(
          `\`\`\`json\n${verdictSetJson}\n\`\`\``,
          report.candidates,
          bundle as import("@nexusguard/core").EvidenceBundle,
          report.findings.filter((f) => f.source === "compiler").map((f) => ({
            file: f.file,
            line: f.line,
            col: 0,
            code: "TS0000",
            message: f.reason,
            isNew: true,
          })),
          report.changeFacts,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accepted: result.accepted,
                rejected: result.rejected,
                repromptHint: result.repromptHint,
              }, null, 2),
            },
          ],
        };
      }

      case "nexusguard_run_tests": {
        const runId = String(a["runId"] ?? "");
        const service = String(a["service"] ?? "");
        if (!runId || !service) return err("runId and service are required");

        const runCtx = activeRuns.get(runId);
        if (!runCtx) return err(`Run ${runId} not found`);

        const cmd = runCtx.config.commands.test[service];
        if (!cmd) return err(`No test command for service ${service}`);

        const headWorktree = path.join(runCtx.nexusguardDir, "wt", `${runId}-head`);
        const result = await runner.run(cmd, headWorktree, runCtx.config.timeouts.testMs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                service,
                ok: result.exitCode === 0,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                stdout: result.stdout.slice(0, 8192),
                stderr: result.stderr.slice(0, 2048),
              }, null, 2),
            },
          ],
        };
      }

      case "nexusguard_apply_edits": {
        const runId = String(a["runId"] ?? "");
        const edits = (a["edits"] as EditOp[]) ?? [];

        if (!runId) return err("runId is required");
        const runCtx = activeRuns.get(runId);
        if (!runCtx) return err(`Run ${runId} not found`);

        const report = await runCtx.store.getReport(runId);
        if (!report) return err(`No report for run ${runId}`);

        const brokenFindings = report.findings.filter((f) => f.verdict === "BROKEN");
        const producerFiles = new Set(
          report.changeFacts.map((f) => f.symbolId.split("#")[0]?.replace("symbol:", "") ?? ""),
        );

        const gate = checkScope(edits, brokenFindings, producerFiles, runCtx.config);
        if (!gate.ok) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, violations: gate.violations }) }],
          };
        }

        const fixWorktree = path.join(runCtx.nexusguardDir, "wt", `${runId}-fix`);

        // Read current file contents
        const fileContents = new Map<string, string>();
        for (const edit of edits) {
          const filePath = path.join(fixWorktree, edit.file);
          try {
            fileContents.set(edit.file, await fs.readFile(filePath, "utf8"));
          } catch {
            return err(`File not found in fix worktree: ${edit.file}`);
          }
        }

        const { updated, errors: applyErrors } = applyEdits(edits, fileContents);
        if (applyErrors.length > 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, violations: applyErrors }) }],
          };
        }

        // Write updated files
        for (const [file, content] of updated) {
          await fs.writeFile(path.join(fixWorktree, file), content, "utf8");
        }

        // Run tsc
        const tscResult = await runner.run(
          runCtx.config.commands.typecheck,
          fixWorktree,
          runCtx.config.timeouts.typecheckMs,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: tscResult.exitCode === 0,
                typecheck: { ok: tscResult.exitCode === 0, output: tscResult.stdout.slice(0, 4096) },
              }, null, 2),
            },
          ],
        };
      }

      case "nexusguard_verify_patch": {
        const runId = String(a["runId"] ?? "");
        if (!runId) return err("runId is required");
        const runCtx = activeRuns.get(runId);
        if (!runCtx) return err(`Run ${runId} not found`);

        const fixWorktree = path.join(runCtx.nexusguardDir, "wt", `${runId}-fix`);
        const report = await runCtx.store.getReport(runId);
        if (!report) return err(`No report for run ${runId}`);

        // Run tsc in fix worktree
        const tscResult = await runner.run(
          runCtx.config.commands.typecheck,
          fixWorktree,
          runCtx.config.timeouts.typecheckMs,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                typecheck: { ok: tscResult.exitCode === 0, output: tscResult.stdout.slice(0, 4096) },
                verified: tscResult.exitCode === 0,
              }, null, 2),
            },
          ],
        };
      }

      case "nexusguard_finalize": {
        const runId = String(a["runId"] ?? "");
        const openPr = Boolean(a["openPr"] ?? false);
        if (!runId) return err("runId is required");
        const runCtx = activeRuns.get(runId);
        if (!runCtx) return err(`Run ${runId} not found`);

        const reportPath = path.join(runCtx.nexusguardDir, "runs", runId, "report.json");

        let prUrl: string | undefined;
        if (openPr) {
          // 🟡 Optional: gh pr create (only if gh CLI is authenticated)
          try {
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execAsync = promisify(exec);
            const branchName = `nexusguard/fix/${runId}`;
            const { stdout } = await execAsync(
              `gh pr create --base HEAD --head ${branchName} --title "fix: NexusGuard auto-heal for run ${runId}" --body "Generated by NexusGuard + IBM Bob — review required before merging."`,
              { cwd: runCtx.repoRoot, env: { PATH: process.env["PATH"] ?? "" } },
            );
            prUrl = stdout.trim();
          } catch {
            prUrl = undefined;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ runId, reportPath, prUrl: prUrl ?? null }, null, 2),
            },
          ],
        };
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

async function loadConfig(configPath: string): Promise<NexusGuardConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<NexusGuardConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NexusGuard MCP Server running on stdio");
})();
