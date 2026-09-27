// packages/core/src/score/scorer.ts
// S10: Blast-radius scorer (deterministic formula) and report builder

import type {
  Finding,
  BlastRadiusReport,
  ChangeFact,
  Candidate,
  DependencyGraph,
  NexusGuardConfig,
  StageTiming,
  RemediationResult,
  GraphNode,
  GraphEdge,
} from "../types.js";

// ─── Score factors ────────────────────────────────────────────────────────────

const S_SEVERITY: Record<string, number> = {
  CRITICAL: 0.85,
  HIGH: 0.60,
  MEDIUM: 0.35,
  LOW: 0.10,
};

const C_CONFIRMATION: Record<string, number> = {
  CONFIRMED_BY_COMPILER: 1.0,
  CONFIRMED_BY_TEST: 1.0,
  LLM_GROUNDED: 0.6,
  UNCERTAIN: 0.0,
};

const K_TIER: Record<number, number> = {
  1: 1.0,
  2: 0.7,
  3: 0.4,
};

export function computeScore(
  findings: Finding[],
  config: NexusGuardConfig,
): { score: number; riskLevel: "SAFE" | "WARNING" | "CRITICAL" } {
  const weights: number[] = [];

  for (const f of findings) {
    if (f.verdict !== "BROKEN" && f.verdict !== "AT_RISK") continue;

    const S = S_SEVERITY[f.severity] ?? 0.1;
    const C = C_CONFIRMATION[f.confirmation] ?? 0.0;
    const tier = config.services[f.service]?.tier ?? 2;
    const K = K_TIER[tier] ?? 0.4;
    const hops = Math.max(1, findings.findIndex((x) => x.findingId === f.findingId) + 1);
    const D = Math.pow(0.85, hops - 1);
    const atRisk = f.verdict === "AT_RISK" ? 0.5 : 1.0;

    const w = S * C * K * D * atRisk;

    findings.forEach((x) => {
      if (x.findingId === f.findingId) {
        x.scoreFactors = { S, C, K, D, atRisk, w };
      }
    });

    weights.push(w);
  }

  if (weights.length === 0) {
    return { score: 0, riskLevel: "SAFE" };
  }

  // Probability-union formula
  const notHit = weights.reduce((acc, w) => acc * (1 - w), 1);
  const score = Math.round(100 * (1 - notHit));
  const riskLevel = score >= 70 ? "CRITICAL" : score >= 30 ? "WARNING" : "SAFE";

  return { score, riskLevel };
}

// ─── Report builder ───────────────────────────────────────────────────────────

export interface ReportBuilderInput {
  runId: string;
  repoRoot: string;
  baseSha: string;
  headSha: string;
  source: "LIVE" | "CACHED" | "REPLAY";
  facts: ChangeFact[];
  candidates: Candidate[];
  findings: Finding[];
  rejectedClaims: Array<{ candidateId?: string; code: string; detail: string }>;
  limitsHit: string[];
  unresolvedHttpCalls: Array<{ file: string; line: number; urlExpr: string }>;
  graph: DependencyGraph;
  timings: StageTiming[];
  llmCalls: number;
  llmLatencyMs: number;
  llmPromptChars: number;
  llmOutputChars: number;
  config: NexusGuardConfig;
  remediation?: RemediationResult;
  semanticStatus: "OK" | "DEGRADED";
}

export function buildReport(input: ReportBuilderInput): BlastRadiusReport {
  const { score, riskLevel } = computeScore(input.findings, input.config);

  // Determine graph node statuses
  const graphNodes: GraphNode[] = [];
  for (const [_id, node] of input.graph.nodes) {
    const finding = input.findings.find(
      (f) => f.candidateId && input.candidates.find(
        (c) => c.candidateId === f.candidateId && c.consumerSymbolId === node.id,
      ),
    );
    const isModified = input.facts.some((f) => f.symbolId === node.id);
    let status = node.status;

    if (isModified) {
      status = "modified";
    } else if (finding) {
      if (finding.resolution === "healed") {
        status = "healed";
      } else if (finding.verdict === "BROKEN") {
        status = "broken";
      } else if (finding.verdict === "AT_RISK") {
        status = "at_risk";
      } else if (finding.verdict === "UNCERTAIN") {
        status = "uncertain";
      }
    }

    graphNodes.push({ ...node, status });
  }

  const graphEdges: GraphEdge[] = input.graph.edges;

  return {
    schemaVersion: "1.0",
    runId: input.runId,
    source: input.source,
    repo: { root: input.repoRoot, baseSha: input.baseSha, headSha: input.headSha },
    promptVersions: { impact: "impact-v1" },
    score,
    riskLevel,
    semanticStatus: input.semanticStatus,
    changeFacts: input.facts,
    candidates: input.candidates,
    findings: input.findings,
    rejectedClaims: input.rejectedClaims,
    limitsHit: input.limitsHit,
    unresolvedHttpCalls: input.unresolvedHttpCalls,
    graph: { nodes: graphNodes, edges: graphEdges },
    timings: input.timings,
    llm: {
      calls: input.llmCalls,
      totalLatencyMs: input.llmLatencyMs,
      promptChars: input.llmPromptChars,
      outputChars: input.llmOutputChars,
    },
    remediation: input.remediation,
  };
}
