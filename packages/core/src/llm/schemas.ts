// packages/core/src/llm/schemas.ts
// Zod schemas for LLM output validation (S8)

import { z } from "zod";

export const Verdict = z.enum(["BROKEN", "AT_RISK", "SAFE", "UNCERTAIN"]);
export const Severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const SemanticChangeType = z.enum([
  "UNIT_CHANGE",
  "VALUE_RANGE_CHANGE",
  "NULLABILITY_CHANGE",
  "FIELD_RENAMED",
  "ENUM_VALUE_CHANGED",
  "FORMAT_CHANGE",
  "SIDE_EFFECT_CHANGE",
  "SIGNATURE_CHANGE",
  "NO_BEHAVIOR_CHANGE",
  "OTHER",
]);

export const ImpactVerdictSet = z
  .object({
    prompt_version: z.literal("impact-v1"),
    producer_change_summary: z.string().max(300),
    semantic_change_type: SemanticChangeType,
    verdicts: z
      .array(
        z
          .object({
            candidate_id: z.string().regex(/^C\d+$/),
            verdict: Verdict,
            severity: Severity,
            evidence_id: z
              .string()
              .regex(/^E\d+$/)
              .optional(),
            line: z.number().int().positive().optional(),
            quote: z.string().max(300).optional(),
            reason: z.string().max(400),
            suggested_fix: z.string().max(300).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ImpactVerdictSetType = z.infer<typeof ImpactVerdictSet>;

export const PatchProposal = z
  .object({
    prompt_version: z.literal("patch-v1"),
    finding_ids: z.array(z.string()).min(1),
    edits: z
      .array(
        z
          .object({
            file: z.string(),
            find: z.string().min(1).max(2000),
            replace: z.string().max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    rationale: z.string().max(500),
  })
  .strict();

export type PatchProposalType = z.infer<typeof PatchProposal>;
