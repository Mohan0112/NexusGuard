// packages/core/src/validate/validator.ts
// S8: Validator and Grounding Checker — V1–V10
// Every rule is deterministic. A failing claim never reaches the report.

import type {
  Candidate,
  ChangeFact,
  CompilerFinding,
  EvidenceBundle,
  Finding,
} from "../types.js";
import { ImpactVerdictSet, type ImpactVerdictSetType } from "../llm/schemas.js";
import { tryParseJson } from "../llm/parse.js";

export type RejectionCode =
  | "SCHEMA_INVALID"
  | "UNKNOWN_CANDIDATE"
  | "MISSING_VERDICT"
  | "DUPLICATE_VERDICT"
  | "EVIDENCE_MISMATCH"
  | "LINE_OUT_OF_RANGE"
  | "QUOTE_NOT_FOUND"
  | "UNSUPPORTED_CLAIM"
  | "CONTRADICTS_ORACLE"
  | "CONTRADICTS_FACTS";

export interface Rejection {
  candidateId?: string;
  code: RejectionCode;
  detail: string;
}

export interface ValidationResult {
  accepted: Finding[];
  rejected: Rejection[];
  repromptHint?: string | undefined;
}

export function validate(
  rawText: string,
  candidates: Candidate[],
  bundle: EvidenceBundle,
  compilerFindings: CompilerFinding[],
  facts: ChangeFact[],
): ValidationResult {
  const rejected: Rejection[] = [];

  // V1: Schema validation
  const parsed = tryParseJson(rawText);
  if (parsed === null) {
    return {
      accepted: [],
      rejected: [{ code: "SCHEMA_INVALID", detail: "No valid JSON fence found in output" }],
      repromptHint: "Your output did not contain a valid ```json fence. Output exactly one JSON object in a ```json fence.",
    };
  }

  const schemaResult = ImpactVerdictSet.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map((i) => i.message).join("; ");
    return {
      accepted: [],
      rejected: [{ code: "SCHEMA_INVALID", detail: `Schema validation failed: ${issues}` }],
      repromptHint: `Schema errors: ${issues}. Fix them and output the corrected JSON.`,
    };
  }

  const verdictSet: ImpactVerdictSetType = schemaResult.data;
  const candidateMap = new Map(candidates.map((c) => [c.candidateId, c]));

  // V2: Every candidate_id must exist in the bundle
  for (const v of verdictSet.verdicts) {
    if (!candidateMap.has(v.candidate_id)) {
      rejected.push({
        candidateId: v.candidate_id,
        code: "UNKNOWN_CANDIDATE",
        detail: `Candidate ${v.candidate_id} does not exist in this run`,
      });
    }
  }

  // V3: Completeness — exactly one verdict per candidate
  const seenCandidates = new Set<string>();
  for (const v of verdictSet.verdicts) {
    if (seenCandidates.has(v.candidate_id)) {
      rejected.push({
        candidateId: v.candidate_id,
        code: "DUPLICATE_VERDICT",
        detail: `Candidate ${v.candidate_id} has more than one verdict`,
      });
    }
    seenCandidates.add(v.candidate_id);
  }
  for (const c of candidates) {
    if (!seenCandidates.has(c.candidateId)) {
      rejected.push({
        candidateId: c.candidateId,
        code: "MISSING_VERDICT",
        detail: `No verdict provided for candidate ${c.candidateId}`,
      });
    }
  }

  // If structural issues, bail early — no point checking evidence
  const structuralCodes: RejectionCode[] = [
    "SCHEMA_INVALID",
    "UNKNOWN_CANDIDATE",
    "MISSING_VERDICT",
    "DUPLICATE_VERDICT",
  ];
  if (rejected.some((r) => structuralCodes.includes(r.code))) {
    const hint = buildRepromptHint(rejected, candidates);
    return { accepted: [], rejected, repromptHint: hint };
  }

  const acceptedFindings: Finding[] = [];
  let findingCounter = 1;

  for (const v of verdictSet.verdicts) {
    const candidate = candidateMap.get(v.candidate_id)!;
    const thisRejections: Rejection[] = [];

    // V4: evidence_id must exist and belong to this candidate or the producer
    if (v.evidence_id !== undefined) {
      const evItem = bundle.allById.get(v.evidence_id);
      if (!evItem) {
        thisRejections.push({
          candidateId: v.candidate_id,
          code: "EVIDENCE_MISMATCH",
          detail: `Evidence ${v.evidence_id} does not exist in this bundle`,
        });
      } else if (
        evItem.role === "consumer" &&
        evItem.candidateId !== v.candidate_id
      ) {
        thisRejections.push({
          candidateId: v.candidate_id,
          code: "EVIDENCE_MISMATCH",
          detail: `Evidence ${v.evidence_id} belongs to candidate ${evItem.candidateId}, not ${v.candidate_id}`,
        });
      } else if (v.line !== undefined && evItem) {
        // V5: line must be inside evidence range
        if (v.line < evItem.startLine || v.line > evItem.endLine + 1) {
          thisRejections.push({
            candidateId: v.candidate_id,
            code: "LINE_OUT_OF_RANGE",
            detail: `Line ${v.line} is outside evidence ${v.evidence_id} range [${evItem.startLine}, ${evItem.endLine}]`,
          });
        } else if (v.quote !== undefined) {
          // V6: quote must be an exact substring of the evidence (±2 lines, whitespace-normalized)
          const contentLines = evItem.content.split("\n");
          const windowStart = Math.max(0, v.line - evItem.startLine - 2);
          const windowEnd = Math.min(contentLines.length, v.line - evItem.startLine + 3);
          const window = contentLines.slice(windowStart, windowEnd).join("\n");
          const normalizedWindow = normalizeWhitespace(window);
          const normalizedQuote = normalizeWhitespace(v.quote);
          if (!normalizedWindow.includes(normalizedQuote)) {
            thisRejections.push({
              candidateId: v.candidate_id,
              code: "QUOTE_NOT_FOUND",
              detail: `Quote "${v.quote.slice(0, 60)}..." not found in evidence ${v.evidence_id} near line ${v.line}`,
            });
          }
        }
      }
    }

    // V7: BROKEN/AT_RISK must include evidence_id, line, and quote
    if (v.verdict === "BROKEN" || v.verdict === "AT_RISK") {
      if (!v.evidence_id || !v.line || !v.quote) {
        thisRejections.push({
          candidateId: v.candidate_id,
          code: "UNSUPPORTED_CLAIM",
          detail: `Verdict ${v.verdict} for ${v.candidate_id} must include evidence_id, line, and quote`,
        });
      }
    }

    // V8: Clamp severity — CRITICAL without compiler/test confirmation → HIGH
    let severity = v.severity;
    if (severity === "CRITICAL") {
      const hasOracleConfirmation = compilerFindings.some(
        (cf) => candidate.useSites.some((us) => us.file === cf.file),
      );
      if (!hasOracleConfirmation) {
        severity = "HIGH"; // clamp
      }
    }

    // V9: Verdict cannot contradict compiler findings
    if (v.verdict === "SAFE") {
      const compilerError = compilerFindings.find((cf) =>
        candidate.useSites.some((us) => us.file === cf.file),
      );
      if (compilerError) {
        thisRejections.push({
          candidateId: v.candidate_id,
          code: "CONTRADICTS_ORACLE",
          detail: `Verdict SAFE contradicts compiler error TS${compilerError.code} in ${compilerError.file}:${compilerError.line}`,
        });
      }
    }

    // V10: semantic_change_type consistency
    const semanticType = verdictSet.semantic_change_type;
    if (
      semanticType === "NO_BEHAVIOR_CHANGE" &&
      (v.verdict === "BROKEN" || v.verdict === "AT_RISK")
    ) {
      const relatedFact = facts.find((f) =>
        candidate.seedFactIds.includes(f.factId),
      );
      if (relatedFact && relatedFact.type === "SIGNATURE_CHANGED") {
        thisRejections.push({
          candidateId: v.candidate_id,
          code: "CONTRADICTS_FACTS",
          detail: `semantic_change_type=NO_BEHAVIOR_CHANGE contradicts fact type SIGNATURE_CHANGED for ${v.candidate_id}`,
        });
      }
    }

    if (thisRejections.length > 0) {
      rejected.push(...thisRejections);
      continue;
    }

    // Build finding
    const finding: Finding = {
      findingId: `FIND-${findingCounter++}`,
      candidateId: v.candidate_id,
      service: candidate.service,
      file: candidate.useSites[0]?.file ?? candidate.consumerSymbolId,
      line: v.line ?? candidate.useSites[0]?.line ?? 0,
      quote: v.quote ?? "",
      verdict: v.verdict,
      severity,
      confirmation: "LLM_GROUNDED",
      reason: v.reason,
      suggestedFix: v.suggested_fix,
      source: "llm",
    };

    acceptedFindings.push(finding);
  }

  const repromptHint = rejected.length > 0 ? buildRepromptHint(rejected, candidates) : undefined;
  return { accepted: acceptedFindings, rejected, repromptHint };
}

function buildRepromptHint(rejections: Rejection[], candidates: Candidate[]): string {
  const lines = rejections.slice(0, 5).map(
    (r) =>
      `- ${r.candidateId ? `Candidate ${r.candidateId}` : "Global"}: [${r.code}] ${r.detail}`,
  );
  if (rejections.length > 5) {
    lines.push(`... and ${rejections.length - 5} more`);
  }
  return (
    `Fix the following validation errors and output the corrected JSON:\n` +
    lines.join("\n") +
    `\nFor any candidate where evidence is insufficient, answer UNCERTAIN instead of guessing.`
  );
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
