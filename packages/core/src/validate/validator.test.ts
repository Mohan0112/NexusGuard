// packages/core/src/validate/validator.test.ts
// Unit tests for S8 Validator (V1-V10) — no LLM required
// Every adversarial output must be rejected or blocked

import { describe, it, expect } from "vitest";
import { validate } from "./validator.js";
import type { Candidate, EvidenceBundle, EvidenceItem, ChangeFact, CompilerFinding } from "../types.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeEvidence(id: string, candidateId?: string): EvidenceItem {
  return {
    evidenceId: id,
    role: candidateId ? "consumer" : "producer_after",
    candidateId,
    file: "services/billing-service/src/invoice.ts",
    startLine: 1,
    endLine: 20,
    content: [
      "1| import { calculateFee } from '@sample/shared-pricing';",
      "2| export function buildInvoice(id: string, subtotal: number) {",
      "3|   const fee = calculateFee(subtotal);",
      "4|   return { id, subtotal, fee, total: subtotal + fee, status: 'OPEN' };",
      "5| }",
    ].join("\n"),
    contentHash: "abc123",
  };
}

function makeBundle(candidates: Candidate[]): EvidenceBundle {
  const producerBefore = makeEvidence("E1");
  const producerAfter = makeEvidence("E2");
  const consumerEvidence: EvidenceItem[] = [];

  for (const c of candidates) {
    const ev = makeEvidence(`E${3 + consumerEvidence.length}`, c.candidateId);
    c.evidenceIds.push(ev.evidenceId);
    consumerEvidence.push(ev);
  }

  const allById = new Map([
    [producerBefore.evidenceId, producerBefore],
    [producerAfter.evidenceId, producerAfter],
    ...consumerEvidence.map((e): [string, EvidenceItem] => [e.evidenceId, e]),
  ]);

  return {
    runId: "test-run",
    producerBefore,
    producerAfter,
    consumerEvidence,
    allById,
    totalChars: 100,
  };
}

function makeCandidate(id: string): Candidate {
  return {
    candidateId: id,
    consumerSymbolId: `symbol:billing/invoice.ts#buildInvoice`,
    service: "@sample/billing-service",
    useSites: [{ file: "services/billing-service/src/invoice.ts", line: 3, col: 14 }],
    path: [],
    serviceHops: 1,
    seedFactIds: ["F1"],
    evidenceIds: [],
  };
}

function makeFact(): ChangeFact {
  return {
    factId: "F1",
    symbolId: "symbol:packages/shared-pricing/src/fees.ts#calculateFee",
    type: "BODY_CHANGED_SAME_SIGNATURE",
    beforeEvidenceId: "E1",
    afterEvidenceId: "E2",
  };
}

const VALID_VERDICT_SET = (candidateId = "C1") =>
  JSON.stringify({
    prompt_version: "impact-v1",
    producer_change_summary: "calculateFee now returns cents instead of dollars",
    semantic_change_type: "UNIT_CHANGE",
    verdicts: [
      {
        candidate_id: candidateId,
        verdict: "BROKEN",
        severity: "HIGH",
        evidence_id: `E3`,
        line: 4,
        quote: "total: subtotal + fee",
        reason: "fee is now in cents; total will be ~100x too large",
      },
    ],
  });

function fenceJson(json: string): string {
  return "```json\n" + json + "\n```";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Validator V1: schema validation", () => {
  it("rejects empty output", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const result = validate("no json here", candidates, bundle, [], [makeFact()]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe("SCHEMA_INVALID");
  });

  it("rejects malformed JSON", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const result = validate("```json\n{bad json\n```", candidates, bundle, [], [makeFact()]);
    expect(result.rejected[0]?.code).toBe("SCHEMA_INVALID");
  });

  it("rejects wrong prompt_version", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const bad = JSON.stringify({
      prompt_version: "impact-v2",
      producer_change_summary: "x",
      semantic_change_type: "OTHER",
      verdicts: [{ candidate_id: "C1", verdict: "SAFE", severity: "LOW", reason: "ok" }],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [makeFact()]);
    expect(result.rejected[0]?.code).toBe("SCHEMA_INVALID");
  });
});

describe("Validator V2: unknown candidate ID", () => {
  it("rejects verdict for non-existent candidate C99", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "OTHER",
      verdicts: [
        { candidate_id: "C99", verdict: "SAFE", severity: "LOW", reason: "ok" },
        { candidate_id: "C1", verdict: "SAFE", severity: "LOW", reason: "ok" },
      ],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [makeFact()]);
    expect(result.rejected.some((r) => r.code === "UNKNOWN_CANDIDATE")).toBe(true);
  });
});

describe("Validator V3: missing verdict", () => {
  it("rejects when one candidate has no verdict", () => {
    const candidates = [makeCandidate("C1"), makeCandidate("C2")];
    const bundle = makeBundle(candidates);
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "OTHER",
      verdicts: [{ candidate_id: "C1", verdict: "SAFE", severity: "LOW", reason: "ok" }],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [makeFact()]);
    expect(result.rejected.some((r) => r.code === "MISSING_VERDICT")).toBe(true);
  });

  it("rejects duplicate verdicts", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "OTHER",
      verdicts: [
        { candidate_id: "C1", verdict: "SAFE", severity: "LOW", reason: "ok" },
        { candidate_id: "C1", verdict: "BROKEN", severity: "HIGH", reason: "also" },
      ],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [makeFact()]);
    expect(result.rejected.some((r) => r.code === "DUPLICATE_VERDICT")).toBe(true);
  });
});

describe("Validator V5/V6: quote not in evidence", () => {
  it("rejects when quote is not found in the evidence", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "UNIT_CHANGE",
      verdicts: [
        {
          candidate_id: "C1",
          verdict: "BROKEN",
          severity: "HIGH",
          evidence_id: "E3",
          line: 3,
          quote: "this text is definitely not in the evidence at all ever",
          reason: "made up",
        },
      ],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [makeFact()]);
    expect(result.rejected.some((r) => r.code === "QUOTE_NOT_FOUND")).toBe(true);
    expect(result.accepted).toHaveLength(0);
  });
});

describe("Validator V7: BROKEN/AT_RISK must have evidence_id, line, quote", () => {
  it("rejects BROKEN without evidence support", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "UNIT_CHANGE",
      verdicts: [
        { candidate_id: "C1", verdict: "BROKEN", severity: "HIGH", reason: "gut feeling" },
      ],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [makeFact()]);
    expect(result.rejected.some((r) => r.code === "UNSUPPORTED_CLAIM")).toBe(true);
  });
});

describe("Validator V9: cannot mark SAFE when compiler has error", () => {
  it("rejects SAFE verdict when compiler found error in that file", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const compilerFinding: CompilerFinding = {
      file: "services/billing-service/src/invoice.ts",
      line: 3,
      col: 0,
      code: "TS2345",
      message: "Type mismatch",
      isNew: true,
    };
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "OTHER",
      verdicts: [{ candidate_id: "C1", verdict: "SAFE", severity: "LOW", reason: "looks fine" }],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [compilerFinding], [makeFact()]);
    expect(result.rejected.some((r) => r.code === "CONTRADICTS_ORACLE")).toBe(true);
  });
});

describe("Validator V10: contradicts facts", () => {
  it("rejects NO_BEHAVIOR_CHANGE for a SIGNATURE_CHANGED fact", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const signatureFact: ChangeFact = {
      factId: "F1",
      symbolId: "symbol:packages/shared-pricing/src/fees.ts#calculateFee",
      type: "SIGNATURE_CHANGED",
      beforeEvidenceId: "E1",
      afterEvidenceId: "E2",
    };
    const ev = bundle.allById.get("E3")!;
    const bad = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "NO_BEHAVIOR_CHANGE",
      verdicts: [
        {
          candidate_id: "C1",
          verdict: "BROKEN",
          severity: "HIGH",
          evidence_id: "E3",
          line: 4,
          quote: "total: subtotal + fee",
          reason: "broken",
        },
      ],
    });
    const result = validate(fenceJson(bad), candidates, bundle, [], [signatureFact]);
    expect(result.rejected.some((r) => r.code === "CONTRADICTS_FACTS")).toBe(true);
  });
});

describe("Happy path: valid verdict is accepted", () => {
  it("accepts a correct BROKEN verdict with exact quote", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const result = validate(
      fenceJson(VALID_VERDICT_SET("C1")),
      candidates,
      bundle,
      [],
      [makeFact()],
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.verdict).toBe("BROKEN");
    expect(result.rejected).toHaveLength(0);
  });

  it("accepts SAFE verdict with no evidence (optional evidence for SAFE)", () => {
    const candidates = [makeCandidate("C1")];
    const bundle = makeBundle(candidates);
    const safe = JSON.stringify({
      prompt_version: "impact-v1",
      producer_change_summary: "x",
      semantic_change_type: "OTHER",
      verdicts: [{ candidate_id: "C1", verdict: "SAFE", severity: "LOW", reason: "not used" }],
    });
    const result = validate(fenceJson(safe), candidates, bundle, [], [makeFact()]);
    expect(result.accepted[0]?.verdict).toBe("SAFE");
    expect(result.rejected).toHaveLength(0);
  });
});
