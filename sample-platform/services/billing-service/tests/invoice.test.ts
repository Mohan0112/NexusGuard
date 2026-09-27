// services/billing-service/tests/invoice.test.ts
import { describe, it, expect } from "vitest";
import { buildInvoice } from "../src/invoice.js";

describe("buildInvoice", () => {
  it("computes total correctly for $100 subtotal", () => {
    const inv = buildInvoice("i1", 100);
    // calculateFee(100) = 3.2 dollars → total = 103.2
    expect(inv.total).toBe(103.2);
    expect(inv.fee).toBe(3.2);
    expect(inv.status).toBe("OPEN");
  });

  it("returns correct structure", () => {
    const inv = buildInvoice("i2", 50);
    expect(inv.id).toBe("i2");
    expect(inv.subtotal).toBe(50);
    // fee = 50 * 0.029 + 0.3 = 1.75
    expect(inv.fee).toBe(1.75);
    expect(inv.total).toBe(51.75);
  });
});
