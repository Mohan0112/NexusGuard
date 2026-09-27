// packages/shared-pricing/tests/fees.test.ts
// BASE: calculateFee returns dollars
import { describe, it, expect } from "vitest";
import { calculateFee, formatMoney } from "../src/fees.js";

describe("calculateFee (dollars)", () => {
  it("returns fee in dollars for $100 order", () => {
    expect(calculateFee(100)).toBe(3.2); // 100 * 0.029 + 0.3 = 3.2
  });
  it("returns fee for $0 order", () => {
    expect(calculateFee(0)).toBe(0.3);
  });
});

describe("formatMoney", () => {
  it("formats USD", () => {
    expect(formatMoney(10, "USD")).toBe("$10.00");
  });
  it("formats EUR", () => {
    expect(formatMoney(9.99, "EUR")).toBe("€9.99");
  });
});
