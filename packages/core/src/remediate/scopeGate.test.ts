// packages/core/src/remediate/scopeGate.test.ts
// Unit tests for ScopeGate and DenyList (§14.4)

import { describe, it, expect } from "vitest";
import { checkScope, applyEdits } from "./scopeGate.js";
import type { Finding, NexusGuardConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

function makeConfig(): NexusGuardConfig {
  return {
    ...DEFAULT_CONFIG,
    services: { "@sample/billing-service": { tier: 1 } },
  };
}

function makeBrokenFinding(file: string): Finding {
  return {
    findingId: "F1",
    candidateId: "C1",
    service: "@sample/billing-service",
    file,
    line: 3,
    quote: "const fee = calculateFee(subtotal);",
    verdict: "BROKEN",
    severity: "HIGH",
    confirmation: "LLM_GROUNDED",
    reason: "fee is now in cents",
    source: "llm",
  };
}

describe("ScopeGate: forbidden file patterns", () => {
  it("blocks edits to test files", () => {
    const edits = [{ file: "services/billing-service/tests/invoice.test.ts", find: "x", replace: "y" }];
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], new Set(), makeConfig());
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("Forbidden"))).toBe(true);
  });

  it("blocks edits to package.json", () => {
    const edits = [{ file: "services/billing-service/package.json", find: "x", replace: "y" }];
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], new Set(), makeConfig());
    expect(result.ok).toBe(false);
  });

  it("blocks edits to tsconfig.json", () => {
    const edits = [{ file: "tsconfig.json", find: "x", replace: "y" }];
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], new Set(), makeConfig());
    expect(result.ok).toBe(false);
  });

  it("blocks edits to producer files", () => {
    const edits = [{ file: "packages/shared-pricing/src/fees.ts", find: "x", replace: "y" }];
    const producerFiles = new Set(["packages/shared-pricing/src/fees.ts"]);
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], producerFiles, makeConfig());
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("Producer file"))).toBe(true);
  });
});

describe("DenyList: forbidden patterns in replacement", () => {
  it("blocks @ts-ignore", () => {
    const edits = [
      {
        file: "services/billing-service/src/invoice.ts",
        find: "const fee = calculateFee(subtotal);",
        replace: "// @ts-ignore\nconst fee = calculateFee(subtotal) as any;",
      },
    ];
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], new Set(), makeConfig());
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("DenyList"))).toBe(true);
  });

  it("blocks as any", () => {
    const edits = [
      {
        file: "services/billing-service/src/invoice.ts",
        find: "const fee = calculateFee(subtotal);",
        replace: "const fee = calculateFee(subtotal) as any;",
      },
    ];
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], new Set(), makeConfig());
    expect(result.ok).toBe(false);
  });

  it("blocks eslint-disable", () => {
    const edits = [
      {
        file: "services/billing-service/src/invoice.ts",
        find: "const fee = calculateFee(subtotal);",
        replace: "// eslint-disable-next-line\nconst fee = 0;",
      },
    ];
    const result = checkScope(edits, [makeBrokenFinding("services/billing-service/src/invoice.ts")], new Set(), makeConfig());
    expect(result.ok).toBe(false);
  });
});

describe("applyEdits: find must match exactly once", () => {
  it("fails when find matches 0 times", () => {
    const files = new Map([["invoice.ts", "const fee = calculateFee(subtotal);"]]);
    const { errors } = applyEdits([{ file: "invoice.ts", find: "DOES_NOT_EXIST", replace: "x" }], files);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/not matched/);
  });

  it("fails when find matches 2+ times", () => {
    const files = new Map([["invoice.ts", "fee\nfee"]]);
    const { errors } = applyEdits([{ file: "invoice.ts", find: "fee", replace: "cost" }], files);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/2 times/);
  });

  it("succeeds when find matches exactly once", () => {
    const files = new Map([["invoice.ts", "const fee = calculateFee(subtotal);"]]);
    const { updated, errors } = applyEdits(
      [{ file: "invoice.ts", find: "calculateFee(subtotal)", replace: "calculateFee(subtotal) / 100" }],
      files,
    );
    expect(errors).toHaveLength(0);
    expect(updated.get("invoice.ts")).toContain("/ 100");
  });
});

describe("Remediation attempt limit (semantic test)", () => {
  it("maxAttempts config is respected", () => {
    const config = makeConfig();
    expect(config.limits.maxAttempts).toBe(3);
  });
});
