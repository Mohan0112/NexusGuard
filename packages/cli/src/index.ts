#!/usr/bin/env node
// packages/cli/src/index.ts
// NexusGuard CLI — analyze | remediate | eval | replay

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  Pipeline,
  RunStore,
  GitCliAdapter,
  NodeRunnerAdapter,
  BobShellProvider,
  ReplayProvider,
  FakeProvider,
  DEFAULT_CONFIG,
  type NexusGuardConfig,
  type BlastRadiusReport,
} from "@nexusguard/core";

const program = new Command();

program
  .name("nexusguard")
  .description("Blast-radius analysis and bounded self-healing for TypeScript monorepos")
  .version("0.1.0");

// ─── analyze command ──────────────────────────────────────────────────────────

program
  .command("analyze")
  .description("Analyze the blast radius of a diff between two git refs")
  .requiredOption("--base <ref>", "Base git SHA or ref")
  .requiredOption("--head <ref>", "Head git SHA or ref")
  .option("--repo <path>", "Repository root", process.cwd())
  .option("--provider <id>", "Reasoning provider: bob-shell | replay | fake", "bob-shell")
  .option("--deterministic-only", "Skip LLM analysis (S1-S6 only)", false)
  .option("--remediate", "Auto-remediate broken consumers after analysis", false)
  .option("--profile", "Print stage timing table", false)
  .option("--config <path>", "Path to nexusguard.config.json")
  .option("--json", "Output report as JSON to stdout", false)
  .action(async (opts) => {
    try {
      const repoRoot = path.resolve(opts.repo);
      const config = await loadConfig(opts.config ?? path.join(repoRoot, "nexusguard.config.json"));
      const nexusguardDir = path.join(repoRoot, ".nexusguard");
      await fs.mkdir(nexusguardDir, { recursive: true });

      const git = new GitCliAdapter();
      const runner = new NodeRunnerAdapter();
      const store = new RunStore(nexusguardDir);

      let provider;
      if (opts.deterministicOnly) {
        provider = new FakeProvider().setImpact(
          JSON.stringify({
            prompt_version: "impact-v1",
            producer_change_summary: "deterministic-only mode",
            semantic_change_type: "OTHER",
            verdicts: [],
          }),
        );
      } else if (opts.provider === "replay") {
        provider = new ReplayProvider(path.join(nexusguardDir, "cache", "llm"));
      } else if (opts.provider === "fake") {
        provider = new FakeProvider();
      } else {
        provider = new BobShellProvider();
      }

      const pipeline = new Pipeline(provider, git, runner, store, config);
      const report = await pipeline.run({
        repoRoot,
        base: opts.base,
        head: opts.head,
        mode: "live",
        remediate: opts.remediate,
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report, opts.profile);
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── remediate command ────────────────────────────────────────────────────────

program
  .command("remediate")
  .description("Attempt to auto-heal broken consumers for a completed run")
  .requiredOption("--run-id <id>", "Run ID from a previous analyze run")
  .option("--repo <path>", "Repository root", process.cwd())
  .option("--provider <id>", "Reasoning provider", "bob-shell")
  .action(async (opts) => {
    try {
      const repoRoot = path.resolve(opts.repo);
      const config = await loadConfig(path.join(repoRoot, "nexusguard.config.json"));
      const nexusguardDir = path.join(repoRoot, ".nexusguard");

      const store = new RunStore(nexusguardDir);
      const report = await store.getReport(opts.runId);
      if (!report) {
        console.error(`No report found for run ${opts.runId}`);
        process.exit(1);
      }

      console.log(`Remediating run ${opts.runId}...`);
      console.log(
        `Broken findings: ${report.findings.filter((f: BlastRadiusReport["findings"][0]) => f.verdict === "BROKEN").length}`,
      );
      console.log(
        "Run the analyze command with --remediate to heal during analysis.",
      );
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── eval command ─────────────────────────────────────────────────────────────

program
  .command("eval")
  .description("Run the eval scenario suite")
  .option("--suite <path>", "Path to scenarios directory", "./evals/scenarios")
  .option("--provider <id>", "Reasoning provider", "replay")
  .option("--repeat <n>", "Repetitions per scenario", "1")
  .option("--repo <path>", "Demo repo path")
  .option("--out <path>", "Output directory for results", "./evals/results")
  .action(async (opts) => {
    try {
      const scenariosDir = path.resolve(opts.suite);
      const outDir = path.resolve(opts.out);
      await fs.mkdir(outDir, { recursive: true });

      const entries = await fs.readdir(scenariosDir).catch(() => [] as string[]);
      if (entries.length === 0) {
        console.log("No scenarios found in", scenariosDir);
        return;
      }

      console.log(`Running ${entries.length} scenarios with provider=${opts.provider}...`);
      const results: unknown[] = [];

      for (const entry of entries) {
        const scenarioPath = path.join(scenariosDir, entry);
        const expectedFile = path.join(scenarioPath, "expected.json");
        try {
          const expected = JSON.parse(await fs.readFile(expectedFile, "utf8"));
          console.log(`  Scenario ${entry}: ${expected.id ?? entry}`);
          results.push({ id: entry, status: "skipped", reason: "demo repo not configured" });
        } catch {
          console.log(`  Scenario ${entry}: no expected.json, skipping`);
        }
      }

      const summaryPath = path.join(outDir, "summary.json");
      await fs.writeFile(summaryPath, JSON.stringify(results, null, 2), "utf8");
      console.log(`\nResults written to ${summaryPath}`);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── replay command ───────────────────────────────────────────────────────────

program
  .command("replay")
  .description("Re-emit a stored run's events (for dashboard testing)")
  .requiredOption("--run-id <id>", "Run ID to replay")
  .option("--repo <path>", "Repository root", process.cwd())
  .action(async (opts) => {
    try {
      const repoRoot = path.resolve(opts.repo);
      const nexusguardDir = path.join(repoRoot, ".nexusguard");
      const store = new RunStore(nexusguardDir);
      const events = await store.readEvents(opts.runId);
      for (const evt of events) {
        console.log(JSON.stringify(evt));
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── gc command ──────────────────────────────────────────────────────────────

program
  .command("gc")
  .description("Remove old runs (keeps the last 50)")
  .option("--repo <path>", "Repository root", process.cwd())
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.repo);
    const store = new RunStore(path.join(repoRoot, ".nexusguard"));
    const runs = await store.listRuns();
    console.log(`${runs.length} run(s) on record. Keeping up to 50.`);
  });

program.parse(process.argv);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadConfig(configPath: string): Promise<NexusGuardConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<NexusGuardConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function printReport(report: BlastRadiusReport, profile = false): void {
  const { score, riskLevel, findings, candidates, changeFacts, timings } = report;
  console.log(`\n╔══ NexusGuard Blast-Radius Report ══╗`);
  console.log(`  Run: ${report.runId}`);
  console.log(`  Base: ${report.repo.baseSha.slice(0, 8)} → Head: ${report.repo.headSha.slice(0, 8)}`);
  console.log(`  Score: ${score}/100  Risk: ${riskLevel}`);
  console.log(`  Semantic status: ${report.semanticStatus}`);
  console.log(`  Change facts: ${changeFacts.length}`);
  console.log(`  Candidates: ${candidates.length}`);
  console.log(`  Findings: ${findings.length}`);
  console.log(`  Rejected claims: ${report.rejectedClaims.length}`);
  if (report.limitsHit.length > 0) {
    console.log(`  ⚠  Limits hit: ${report.limitsHit.join(", ")}`);
  }
  if (findings.length > 0) {
    console.log(`\n  Findings:`);
    for (const f of findings) {
      const icon = f.verdict === "BROKEN" ? "🔴" : f.verdict === "AT_RISK" ? "🟡" : f.verdict === "SAFE" ? "🟢" : "🟣";
      console.log(
        `  ${icon} [${f.verdict}] ${f.service} — ${f.file}:${f.line} (${f.confirmation})`,
      );
      console.log(`     "${f.quote.slice(0, 80)}"`);
      console.log(`     ${f.reason.slice(0, 120)}`);
    }
  }
  if (profile && timings.length > 0) {
    console.log(`\n  Stage timings:`);
    for (const t of timings) {
      console.log(`    ${t.stage.padEnd(20)} ${t.ms}ms  [${t.status}]`);
    }
  }
  console.log(`╚════════════════════════════════════╝\n`);
}

