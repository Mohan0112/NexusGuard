// packages/core/src/types.ts
// Central data contracts for NexusGuard — Part 1

export type NodeId = string;
export type Confirmation =
  | "CONFIRMED_BY_COMPILER"
  | "CONFIRMED_BY_TEST"
  | "LLM_GROUNDED"
  | "UNCERTAIN";
export type RunSource = "LIVE" | "CACHED" | "REPLAY";

// ─── Change facts ────────────────────────────────────────────────────────────

export type ChangeFactType =
  | "COSMETIC_ONLY"
  | "EXPORT_REMOVED"
  | "EXPORT_ADDED"
  | "SIGNATURE_CHANGED"
  | "TYPE_SHAPE_CHANGED"
  | "LITERAL_VALUE_CHANGED"
  | "BODY_CHANGED_SAME_SIGNATURE"
  | "ROUTE_CONTRACT_CHANGED";

export interface ChangeFact {
  factId: string;                       // F1..
  symbolId: NodeId;                     // symbol:packages/shared-pricing/src/fees.ts#calculateFee
  type: ChangeFactType;
  beforeSignature?: string | undefined;
  afterSignature?: string | undefined;
  beforeSnippet?: string | undefined;
  afterSnippet?: string | undefined;
  beforeEvidenceId: string;             // E1
  afterEvidenceId: string;              // E2
}

// ─── Graph ───────────────────────────────────────────────────────────────────

export type NodeKind = "service" | "file" | "symbol" | "route";
export type NodeStatus =
  | "clean"
  | "modified"
  | "broken"
  | "at_risk"
  | "uncertain"
  | "healed"
  | "import_only_unaffected";

export interface GraphNode {
  id: NodeId;
  label: string;
  kind: NodeKind;
  service: string;
  status: NodeStatus;
}

export type EdgeType =
  | "IMPORTS"
  | "REFERENCES"
  | "HANDLES"
  | "HTTP_CALLS"
  | "CONTAINS";

export interface GraphEdge {
  source: NodeId;
  target: NodeId;
  type: EdgeType;
  file?: string;
  line?: number;
  col?: number;
}

export interface DependencyGraph {
  nodes: Map<NodeId, GraphNode>;
  edges: GraphEdge[];
  // adjacency: target → sources (reverse BFS)
  reverseAdj: Map<NodeId, GraphEdge[]>;
  // adjacency: source → targets
  forwardAdj: Map<NodeId, GraphEdge[]>;
}

// ─── Changed regions ─────────────────────────────────────────────────────────

export interface ChangedRegion {
  file: string;
  side: "base" | "head";
  startLine: number;
  endLine: number;
  kind: "add" | "del" | "mod";
}

// ─── Candidates ──────────────────────────────────────────────────────────────

export interface UseSite {
  file: string;
  line: number;
  col: number;
}

export interface Candidate {
  candidateId: string;                  // C1..
  consumerSymbolId: NodeId;
  service: string;
  useSites: UseSite[];
  path: NodeId[];                       // seed → ... → consumer
  serviceHops: number;
  seedFactIds: string[];
  evidenceIds: string[];
}

// ─── Evidence ────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  evidenceId: string;                   // E1..
  role: "producer_before" | "producer_after" | "consumer";
  candidateId?: string;
  file: string;
  startLine: number;
  endLine: number;
  content: string;                      // with line numbers: "42| ..."
  contentHash: string;                  // sha256
}

export interface EvidenceBundle {
  runId: string;
  producerBefore: EvidenceItem;         // E1
  producerAfter: EvidenceItem;          // E2
  consumerEvidence: EvidenceItem[];     // E3..
  allById: Map<string, EvidenceItem>;
  totalChars: number;
}

// ─── Compiler/test findings ───────────────────────────────────────────────────

export interface CompilerFinding {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  isNew: boolean;                       // not in base
}

export interface TestResult {
  service: string;
  ok: boolean;
  failed: string[];
  durationMs: number;
  isBaseline: boolean;
}

// ─── Findings (core) ────────────────────────────────────────────────────────

export type Verdict = "BROKEN" | "AT_RISK" | "SAFE" | "UNCERTAIN";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ScoreFactors {
  S: number;
  C: number;
  K: number;
  D: number;
  atRisk: number;
  w: number;
}

export interface Finding {
  findingId: string;
  candidateId: string;
  service: string;
  file: string;
  line: number;
  quote: string;
  verdict: Verdict;
  severity: Severity;
  confirmation: Confirmation;
  reason: string;
  suggestedFix?: string | undefined;
  source: "compiler" | "llm" | "test";
  scoreFactors?: ScoreFactors | undefined;
  resolution?: "healed" | "resolved_by_upstream_fix" | undefined;
}

// ─── Remediation ─────────────────────────────────────────────────────────────

export interface EditOp {
  file: string;
  find: string;
  replace: string;
}

export interface AttemptResult {
  n: number;
  edits: EditOp[];
  gate: { ok: boolean; violations: string[] };
  typecheck: { ok: boolean; errors?: string };
  tests: Array<{ service: string; ok: boolean; failed: string[] }>;
  ms: number;
}

export interface RemediationResult {
  status: "NOT_RUN" | "SUCCESS" | "MANUAL_REVIEW_REQUIRED";
  branch?: string | undefined;
  attempts: AttemptResult[];
  finalDiff?: string | undefined;
  prUrl?: string | undefined;
}

// ─── Stage timing ────────────────────────────────────────────────────────────

export interface StageTiming {
  stage: string;
  startedAt: string;
  ms: number;
  status: "ok" | "timeout" | "error" | "skipped";
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface BlastRadiusReport {
  schemaVersion: "1.0";
  runId: string;
  source: RunSource;
  repo: { root: string; baseSha: string; headSha: string };
  promptVersions: { impact: string; patch?: string | undefined };
  score: number;
  riskLevel: "SAFE" | "WARNING" | "CRITICAL";
  semanticStatus: "OK" | "DEGRADED";
  changeFacts: ChangeFact[];
  candidates: Candidate[];
  findings: Finding[];
  rejectedClaims: Array<{ candidateId?: string | undefined; code: string; detail: string }>;
  limitsHit: string[];
  unresolvedHttpCalls: Array<{ file: string; line: number; urlExpr: string }>;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  timings: StageTiming[];
  llm: { calls: number; totalLatencyMs: number; promptChars: number; outputChars: number };
  remediation?: RemediationResult | undefined;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type NexusEvent =
  | { type: "run.started"; data: { base: string; head: string; source: RunSource } }
  | { type: "stage.started"; data: { stage: string } }
  | { type: "stage.completed"; data: { stage: string; ms: number; status: string } }
  | { type: "graph.ready"; data: { nodes: number; edges: number } }
  | { type: "node.status"; data: { id: NodeId; status: NodeStatus } }
  | { type: "finding.added"; data: { findingId: string; confirmation: Confirmation } }
  | { type: "finding.rejected"; data: { code: string; candidateId?: string | undefined; detail: string } }
  | { type: "finding.confirmed"; data: { findingId: string; by: Confirmation } }
  | { type: "run.degraded"; data: { reason: string } }
  | { type: "remediation.attempt"; data: { n: number; gate: string; typecheck: string; tests: string } }
  | { type: "node.status"; data: { id: NodeId; status: NodeStatus } }
  | { type: "run.completed"; data: { score: number; riskLevel: string } };

export interface NexusEventRecord {
  ts: string;
  runId: string;
  seq: number;
  type: NexusEvent["type"];
  data: unknown;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface NexusGuardConfig {
  services: Record<string, { tier: number }>;
  commands: {
    typecheck: string[];
    test: Record<string, string[]>;
  };
  limits: {
    maxDiffLines: number;
    maxCandidates: number;
    maxServiceHops: number;
    maxCharsPerCall: number;
    maxLLMCallsPerRun: number;
    maxAttempts: number;
    maxChangedLinesPerAttempt: number;
    maxFilesPerAttempt: number;
  };
  timeouts: {
    llmMs: number;
    typecheckMs: number;
    testMs: number;
    attemptMs: number;
  };
}

export const DEFAULT_CONFIG: NexusGuardConfig = {
  services: {},
  commands: {
    typecheck: ["npx", "tsc", "-b", "--pretty", "false"],
    test: {},
  },
  limits: {
    maxDiffLines: 2000,
    maxCandidates: 40,
    maxServiceHops: 3,
    maxCharsPerCall: 40000,
    maxLLMCallsPerRun: 8,
    maxAttempts: 3,
    maxChangedLinesPerAttempt: 30,
    maxFilesPerAttempt: 5,
  },
  timeouts: {
    llmMs: 60000,
    typecheckMs: 60000,
    testMs: 120000,
    attemptMs: 90000,
  },
};
