// services/notification-service/tests/receipt.test.ts
import { describe, it, expect } from "vitest";
import { renderReceipt } from "../src/receipt.js";

describe("renderReceipt", () => {
  it("formats receipt in dollars", () => {
    const result = renderReceipt({
      id: "i1",
      subtotal: 100,
      fee: 3.2,
      total: 103.2,
      status: "OPEN",
    });
    expect(result).toContain("Total: $103.20");
    expect(result).toContain("Fee: $3.20");
  });
});
