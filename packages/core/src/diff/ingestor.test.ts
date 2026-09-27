// packages/core/src/diff/ingestor.test.ts
// Unit tests for DiffIngestor.parseDiff

import { describe, it, expect } from "vitest";
import { parseDiff } from "./ingestor.js";

const SAMPLE_DIFF = `diff --git a/packages/shared-pricing/src/fees.ts b/packages/shared-pricing/src/fees.ts
index abc123..def456 100644
--- a/packages/shared-pricing/src/fees.ts
+++ b/packages/shared-pricing/src/fees.ts
@@ -10,3 +10,3 @@ export type CurrencyCode = "USD" | "EUR" | "INR";
-export function calculateFee(amount: number): number {
-  return Math.round((amount * 0.029 + 0.3) * 100) / 100;
+export function calculateFee(amount: number): number {
+  return Math.round(amount * 2.9 + 30);
 }
`;

describe("parseDiff", () => {
  it("returns regions for changed TS lines", () => {
    const regions = parseDiff(SAMPLE_DIFF);
    expect(regions.length).toBeGreaterThan(0);
    const headRegion = regions.find((r) => r.side === "head");
    expect(headRegion).toBeDefined();
    expect(headRegion?.file).toBe("packages/shared-pricing/src/fees.ts");
  });

  it("returns empty array for empty diff", () => {
    expect(parseDiff("")).toHaveLength(0);
  });

  it("ignores non-TS files", () => {
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-old
+new
`;
    const regions = parseDiff(diff);
    expect(regions).toHaveLength(0);
  });
});
