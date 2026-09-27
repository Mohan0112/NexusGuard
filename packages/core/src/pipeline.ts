// packages/core/src/pipeline.ts
// Main pipeline orchestrator — S1 through S12

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { ReasoningProvider } from "./ports/reasoning.js";
import type { GitPort } from "./ports/git.js";
import type { TestRunnerPort } from "./ports/runner.js";
import type { EventSink } from "./ports/events.js";
import type {
  NexusGuardConfig,
  BlastRadiusReport,
  Finding,
  StageTiming,
  ChangeFact,
  EvidenceItem,
} from "./types.js";
import { DiffIngestor } from "./diff/ingestor.js";
import { WorkspaceGraphBuilder } from "./graph/builder.js";
import { ChangeClassifier } from "./classify/classifier.js";
import { expandCandidates } from "./expand/expander.js";
import { CompilerOracle } from "./oracles/compiler.js";
import { EvidenceBundler } from "./bundle/bundler.js";
import { renderImpactPrompt } from "./llm/prompts.js";
import { validate } from "./validate/validator.js";
import { TestOracle } from "./oracles/tests.js";
import { buildReport } from "./score/scorer.js";
import { Remediator } from "./remediate/remediator.js";
import { RunStore } from "./store/runStore.js";
import { timed } from "./telemetry/timed.js";

export interface PipelineInput {
  repoRoot: string;
  base: string;
  head: string;
  mode: "live" | "replay";
  remediate?: boolean;
}

export interface PipelineContext {
  runId: string;
  nexusguardDir: string;
  config: NexusGuardConfig;
}

export class Pipeline {
  constructor(
    private readonly reasoning: ReasoningProvider,
    private readonly git: GitPort,
    private readonly runner: TestRunnerPort,
    private readonly store: RunStore,
    private readonly config: NexusGuardConfig,
  ) {}

  async run(input: PipelineInput): Promise<BlastRadiusReport> {
    const nexusguardDir = path.join(input.repoRoot, ".nexusguard");
    const runId = generateRunId(input.base, input.head);

    const ctx: PipelineContext = { runId, nexusguardDir, config: this.config };

    await this.store.initRun(runId, { ...input, runId });
    await this.store.emit(runId, {
      type: "run.started",
      data: { base: input.base, head: input.head, source: "LIVE" },
    });

    const timings: StageTiming[] = [];
    let semanticStatus: "OK" | "DEGRADED" = "OK";

    // S1: DiffIngestor
    const ingestor = new DiffIngestor(this.git, input.repoRoot, nexusguardDir);
    const { result: ingestResult, ms: s1ms } = await timed("S1-diff", runId, this.store, () =>
      ingestor.ingest(runId, input.base, input.head, this.config.limits.maxDiffLines),
    );
    timings.push({ stage: "S1-diff", startedAt: new Date().toISOString(), ms: s1ms, status: "ok" });

    if (ingestResult.regions.length === 0) {
      return this.emptyReport(runId, input, "No TS/TSX changes found", timings);
    }

    if (ingestResult.changedLineCount > this.config.limits.maxDiffLines) {
      await this.store.emit(runId, {
        type: "run.degraded",
        data: { reason: `diff exceeds maxDiffLines (${ingestResult.changedLineCount})` },
      });
    }

    // S2: WorkspaceGraphBuilder
    const graphBuilder = new WorkspaceGraphBuilder();
    const tsconfigPath = path.join(ingestResult.headPath, "tsconfig.json");
    const { result: graph, ms: s2ms } = await timed("S2-graph", runId, this.store, () =>
      graphBuilder.build({
        headWorktreePath: ingestResult.headPath,
        tsconfigPath,
        services: this.config.services,
      }),
    );
    timings.push({ stage: "S2-graph", startedAt: new Date().toISOString(), ms: s2ms, status: "ok" });

    await this.store.emit(runId, {
      type: "graph.ready",
      data: { nodes: graph.nodes.size, edges: graph.edges.length },
    });

    // Save graph for the dashboard
    await fs.writeFile(
      path.join(this.store.runDir(runId), "graph.json"),
      JSON.stringify(
        {
          nodes: Array.from(graph.nodes.values()),
          edges: graph.edges,
        },
        null,
        2,
      ),
      "utf8",
    );

    // S3: ChangeClassifier
    const classifier = new ChangeClassifier(this.git, input.repoRoot);
    const { result: classifyResult, ms: s3ms } = await timed("S3-classify", runId, this.store, () =>
      classifier.classify(
        ingestResult.regions,
        input.base,
        ingestResult.basePath,
        ingestResult.headPath,
      ),
    );
    timings.push({ stage: "S3-classify", startedAt: new Date().toISOString(), ms: s3ms, status: "ok" });

    const nonCosmeticFacts = classifyResult.facts.filter(
      (f) => f.type !== "COSMETIC_ONLY",
    );

    if (nonCosmeticFacts.length === 0) {
      return this.emptyReport(runId, input, "Only cosmetic changes found", timings);
    }

    // Mark modified symbols in the graph
    for (const fact of classifyResult.facts) {
      const node = graph.nodes.get(fact.symbolId);
      if (node) {
        node.status = "modified";
        await this.store.emit(runId, {
          type: "node.status",
          data: { id: fact.symbolId, status: "modified" },
        });
      }
    }

    // S4: CandidateExpander
    const changedSymbolIds = new Set(classifyResult.facts.map((f) => f.symbolId));
    const { result: expandResult, ms: s4ms } = await timed("S4-expand", runId, this.store, async () => {
      // Re-build graph with lazy refs for changed symbols
      const graphWithRefs = await graphBuilder.build({
        headWorktreePath: ingestResult.headPath,
        tsconfigPath,
        services: this.config.services,
        changedSymbolIds,
      });
      return expandCandidates(nonCosmeticFacts, graphWithRefs, this.config);
    });
    timings.push({ stage: "S4-expand", startedAt: new Date().toISOString(), ms: s4ms, status: "ok" });

    // Mark import-only-unaffected nodes
    for (const nodeId of expandResult.importOnlyUnaffected) {
      const node = graph.nodes.get(nodeId);
      if (node) node.status = "import_only_unaffected";
    }

    // S5: CompilerOracle
    const oracle = new CompilerOracle(this.runner, this.config);
    const changedFiles = new Set(ingestResult.regions.map((r) => r.file));
    const baseErrors = await oracle.buildBaseErrorSet(ingestResult.basePath);

    const { result: compilerResult, ms: s5ms } = await timed("S5-compiler", runId, this.store, () =>
      oracle.run(ingestResult.headPath, changedFiles, baseErrors),
    );
    timings.push({ stage: "S5-compiler", startedAt: new Date().toISOString(), ms: s5ms, status: compilerResult.timedOut ? "timeout" : "ok" });

    // Create compiler findings for candidates
    const compilerFindings: Finding[] = [];
    let compilerFindingCounter = 1;
    for (const cf of compilerResult.findings) {
      const matchedCandidate = expandResult.candidates.find((c) =>
        c.useSites.some((us) => us.file === cf.file),
      );
      if (matchedCandidate) {
        compilerFindings.push({
          findingId: `CF-${compilerFindingCounter++}`,
          candidateId: matchedCandidate.candidateId,
          service: matchedCandidate.service,
          file: cf.file,
          line: cf.line,
          quote: cf.message.slice(0, 200),
          verdict: "BROKEN",
          severity: "HIGH",
          confirmation: "CONFIRMED_BY_COMPILER",
          reason: `${cf.code}: ${cf.message}`,
          source: "compiler",
        });
      }
    }

    // S6: EvidenceBundler
    const bundler = new EvidenceBundler();
    const { result: bundles, ms: s6ms } = await timed("S6-bundle", runId, this.store, () =>
      bundler.buildBundle(
        runId,
        nonCosmeticFacts,
        expandResult.candidates,
        classifyResult.evidence,
        { maxCharsPerCall: this.config.limits.maxCharsPerCall, headWorktreePath: ingestResult.headPath },
      ),
    );
    timings.push({ stage: "S6-bundle", startedAt: new Date().toISOString(), ms: s6ms, status: "ok" });

    // Save bundle
    await fs.writeFile(
      path.join(this.store.runDir(runId), "bundle.json"),
      JSON.stringify(
        bundles.map((b) => ({
          ...b,
          allById: Array.from(b.allById.entries()),
        })),
        null,
        2,
      ),
      "utf8",
    );

    // S7 + S8: SemanticReasoner + Validator (one call per bundle, max 2 concurrent)
    const allFindings: Finding[] = [...compilerFindings];
    const allRejected: Array<{ candidateId?: string; code: string; detail: string }> = [];
    let llmCalls = 0;
    let llmLatencyMs = 0;
    let llmPromptChars = 0;
    let llmOutputChars = 0;

    for (let bi = 0; bi < bundles.length; bi++) {
      const bundle = bundles[bi]!;
      const bundleCandidates = expandResult.candidates.filter((c) =>
        bundle.consumerEvidence.some((e) => e.candidateId === c.candidateId),
      );

      if (bundleCandidates.length === 0 && expandResult.candidates.length > 0) {
        // Single bundle covers all candidates
        bundleCandidates.push(...expandResult.candidates);
      }

      const promptText = renderImpactPrompt(nonCosmeticFacts, bundleCandidates, bundle);

      await this.store.saveLlmPrompt(runId, "impact", bi + 1, promptText);

      let rawText = "";
      try {
        const llmResult = await this.reasoning.analyzeImpact(
          { runId, promptText, promptVersion: "impact-v1" },
          { timeoutMs: this.config.timeouts.llmMs, runId, attempt: bi + 1 },
        );
        rawText = llmResult.text;
        llmCalls++;
        llmLatencyMs += llmResult.latencyMs;
        llmPromptChars += llmResult.promptChars;
        llmOutputChars += llmResult.outputChars;
      } catch {
        semanticStatus = "DEGRADED";
        await this.store.emit(runId, {
          type: "run.degraded",
          data: { reason: "llm_timeout" },
        });
        continue;
      }

      await this.store.saveLlmRaw(runId, "impact", bi + 1, rawText);

      // S8: Validate
      let validationResult = validate(
        rawText,
        bundleCandidates,
        bundle,
        compilerResult.findings,
        nonCosmeticFacts,
      );

      // Re-prompt once on rejection
      if (validationResult.rejected.length > 0 && validationResult.repromptHint) {
        const rePromptText = promptText + `\n\nVALIDATION ERRORS — FIX THESE:\n${validationResult.repromptHint}`;
        try {
          const llmResult2 = await this.reasoning.analyzeImpact(
            { runId, promptText: rePromptText, promptVersion: "impact-v1" },
            { timeoutMs: this.config.timeouts.llmMs, runId, attempt: bi + 10 },
          );
          validationResult = validate(
            llmResult2.text,
            bundleCandidates,
            bundle,
            compilerResult.findings,
            nonCosmeticFacts,
          );
          llmCalls++;
          llmLatencyMs += llmResult2.latencyMs;
        } catch {
          // keep original validation result
        }
      }

      await this.store.saveLlmValidation(runId, "impact", bi + 1, validationResult);

      for (const f of validationResult.accepted) {
        allFindings.push(f);
        await this.store.emit(runId, {
          type: "finding.added",
          data: { findingId: f.findingId, confirmation: f.confirmation },
        });
      }
      for (const r of validationResult.rejected) {
        allRejected.push(r);
        await this.store.emit(runId, {
          type: "finding.rejected",
          data: { code: r.code, candidateId: r.candidateId, detail: r.detail },
        });
      }
    }

    // S9: TestOracle
    const testOracle = new TestOracle(
      this.runner,
      this.config,
      path.join(nexusguardDir, "cache"),
    );
    const { result: testResult, ms: s9ms } = await timed("S9-tests", runId, this.store, () =>
      testOracle.run(allFindings, ingestResult.headPath, input.base),
    );
    timings.push({ stage: "S9-tests", startedAt: new Date().toISOString(), ms: s9ms, status: "ok" });

    const confirmedFindings = testResult.findings;
    for (const f of confirmedFindings) {
      if (f.confirmation === "CONFIRMED_BY_TEST") {
        await this.store.emit(runId, {
          type: "finding.confirmed",
          data: { findingId: f.findingId, by: "CONFIRMED_BY_TEST" },
        });
      }
    }

    // S10: Score + Report
    const { result: report, ms: s10ms } = await timed("S10-score", runId, this.store, async () => {
      return buildReport({
        runId,
        repoRoot: input.repoRoot,
        baseSha: input.base,
        headSha: input.head,
        source: "LIVE",
        facts: nonCosmeticFacts,
        candidates: expandResult.candidates,
        findings: confirmedFindings,
        rejectedClaims: allRejected,
        limitsHit: expandResult.limitsHit,
        unresolvedHttpCalls: [],
        graph,
        timings,
        llmCalls,
        llmLatencyMs,
        llmPromptChars,
        llmOutputChars,
        config: this.config,
        semanticStatus,
      });
    });
    timings.push({ stage: "S10-score", startedAt: new Date().toISOString(), ms: s10ms, status: "ok" });

    await this.store.saveReport(runId, report);
    await this.store.emit(runId, {
      type: "run.completed",
      data: { score: report.score, riskLevel: report.riskLevel },
    });

    // S11 + S12: Remediation (on demand)
    if (input.remediate) {
      const producerBefore = classifyResult.evidence.find((e) => e.role === "producer_before");
      const producerAfter = classifyResult.evidence.find((e) => e.role === "producer_after");
      const producerFiles = new Set(nonCosmeticFacts.map((f) => f.symbolId.split("#")[0]?.replace("symbol:", "") ?? ""));

      const remediator = new Remediator(this.reasoning, this.git, this.runner, this.config);
      const remResult = await remediator.remediate(
        confirmedFindings,
        nonCosmeticFacts,
        producerBefore?.content ?? "",
        producerAfter?.content ?? "",
        { runId, headSha: input.head, repoRoot: input.repoRoot, nexusguardDir, producerFiles },
      );

      const finalReport = { ...report, remediation: remResult };
      await this.store.saveReport(runId, finalReport);
      return finalReport;
    }

    return report;
  }

  private async emptyReport(
    runId: string,
    input: PipelineInput,
    reason: string,
    timings: StageTiming[],
  ): Promise<BlastRadiusReport> {
    const emptyGraph = {
      nodes: new Map(),
      edges: [],
      reverseAdj: new Map(),
      forwardAdj: new Map(),
    };
    const r = buildReport({
      runId,
      repoRoot: input.repoRoot,
      baseSha: input.base,
      headSha: input.head,
      source: "LIVE",
      facts: [],
      candidates: [],
      findings: [],
      rejectedClaims: [],
      limitsHit: [reason],
      unresolvedHttpCalls: [],
      graph: emptyGraph,
      timings,
      llmCalls: 0,
      llmLatencyMs: 0,
      llmPromptChars: 0,
      llmOutputChars: 0,
      config: this.config,
      semanticStatus: "OK",
    });
    await this.store.saveReport(runId, r);
    return r;
  }
}

function generateRunId(base: string, head: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hash = crypto
    .createHash("sha256")
    .update(`${base}${head}${ts}`)
    .digest("hex")
    .slice(0, 8);
  return `${ts}-${hash}`;
}
