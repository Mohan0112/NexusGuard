// packages/shared-pricing/src/fees.ts
// PR #104 (feat/integer-fees) — calculateFee returns INTEGER CENTS
// tsc passes: signature is unchanged (number → number)
// BUT behavior changed: 100 → 320 (cents) not 3.2 (dollars)

export type CurrencyCode = "USD" | "EUR" | "INR";

/**
 * Processing fee in integer cents (avoids float drift).
 * @param amount - The order subtotal in dollars
 * @returns The processing fee in INTEGER CENTS (e.g., $100 → 320 cents)
 */
export function calculateFee(amount: number): number {
  return Math.round(amount * 2.9 + 30);  // 100 → 320 (cents)
}

/**
 * Format a monetary value for display.
 */
export function formatMoney(value: number, currency: CurrencyCode): string {
  const symbols: Record<CurrencyCode, string> = { USD: "$", EUR: "€", INR: "₹" };
  const sym = symbols[currency] ?? "$";
  return `${sym}${value.toFixed(2)}`;
}
