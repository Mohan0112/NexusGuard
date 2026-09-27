// services/checkout-service/tests/checkout.test.ts
import { describe, it, expect } from "vitest";
import { displayCartTotal, getAvailableCurrencies } from "../src/checkout.js";

describe("checkout (negative control)", () => {
  it("displays cart total", () => {
    expect(displayCartTotal(29.99, "USD")).toBe("Your total: $29.99");
  });
  it("returns available currencies", () => {
    expect(getAvailableCurrencies()).toContain("USD");
  });
});
