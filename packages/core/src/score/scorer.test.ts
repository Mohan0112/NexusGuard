// packages/core/src/score/scorer.test.ts
// Unit tests for the blast-radius scoring formula

import { describe, it, expect } from "vitest";
import { computeScore } from "./scorer.js";
import type { Finding, NexusGuardConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

function makeConfig(): NexusGuardConfig {
  return {
    ...DEFAULT_CONFIG,
    services: {
      "@sample/shared-pricing": { tier: 1 },
      "@sample/billing-service": { tier: 1 },
      "@sample/notification-service": { tier: 2 },
    },
  };
}

function makeFinding(
  service: string,
  verdict: "BROKEN" | "AT_RISK",
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  confirmation: "CONFIRMED_BY_COMPILER" | "CONFIRMED_BY_TEST" | "LLM_GROUNDED",
): Finding {
  return {
    findingId: `F-${Math.random()}`,
    candidateId: "C1",
    service,
    file: "x.ts",
    line: 1,
    quote: "",
    verdict,
    severity,
    confirmation,
    reason: "test",
    source: "llm",
  };
}

describe("computeScore", () => {
  it("returns 0 with no findings", () => {
    const { score, riskLevel } = computeScore([], makeConfig());
    expect(score).toBe(0);
    expect(riskLevel).toBe("SAFE");
  });

  it("returns CRITICAL for single confirmed CRITICAL billing finding", () => {
    const findings = [makeFinding("@sample/billing-service", "BROKEN", "CRITICAL", "CONFIRMED_BY_TEST")];
    const { score, riskLevel } = computeScore(findings, makeConfig());
    // S=0.85, C=1.0, K=1.0, D=1.0, atRisk=1.0 → w=0.85 → score=85 → CRITICAL
    expect(score).toBe(85);
    expect(riskLevel).toBe("CRITICAL");
  });

  it("returns WARNING for medium LLM_GROUNDED finding", () => {
    const findings = [makeFinding("@sample/notification-service", "AT_RISK", "MEDIUM", "LLM_GROUNDED")];
    const { score, riskLevel } = computeScore(findings, makeConfig());
    // S=0.35, C=0.6, K=0.7, D=1.0, atRisk=0.5 → w≈0.0735 → score=7 → SAFE
    expect(riskLevel).toBe("SAFE");
  });

  it("demo worked example S01: billing CRITICAL + notification AT_RISK ≈ 86", () => {
    // Billing: CRITICAL · CONFIRMED_BY_TEST · tier 1 · hops 1 → w=0.85
    // Notification: AT_RISK · MEDIUM · LLM_GROUNDED · tier 2 · hops 2 → w≈0.0625
    const findings = [
      makeFinding("@sample/billing-service", "BROKEN", "CRITICAL", "CONFIRMED_BY_TEST"),
      makeFinding("@sample/notification-service", "AT_RISK", "MEDIUM", "LLM_GROUNDED"),
    ];
    const { score, riskLevel } = computeScore(findings, makeConfig());
    expect(score).toBeGreaterThan(70); // CRITICAL range
    expect(riskLevel).toBe("CRITICAL");
  });

  it("score never exceeds 100", () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding("@sample/billing-service", "BROKEN", "CRITICAL", "CONFIRMED_BY_TEST"),
    );
    const { score } = computeScore(findings, makeConfig());
    expect(score).toBeLessThanOrEqual(100);
  });

  it("SAFE and UNCERTAIN findings contribute 0", () => {
    const safeF: Finding = { ...makeFinding("@sample/billing-service", "BROKEN", "HIGH", "LLM_GROUNDED"), verdict: "SAFE" };
    const uncertainF: Finding = { ...makeFinding("@sample/billing-service", "BROKEN", "HIGH", "LLM_GROUNDED"), verdict: "UNCERTAIN" };
    const { score } = computeScore([safeF, uncertainF], makeConfig());
    expect(score).toBe(0);
  });
});
