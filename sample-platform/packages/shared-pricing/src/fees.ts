// packages/shared-pricing/src/fees.ts
// BASE version (main branch) — calculateFee returns DOLLARS

export type CurrencyCode = "USD" | "EUR" | "INR";

/**
 * Processing fee for an order amount, in dollars.
 * @param amount - The order subtotal in dollars
 * @returns The processing fee in dollars
 */
export function calculateFee(amount: number): number {
  return Math.round((amount * 0.029 + 0.3) * 100) / 100;
}

/**
 * Format a monetary value for display.
 */
export function formatMoney(value: number, currency: CurrencyCode): string {
  const symbols: Record<CurrencyCode, string> = { USD: "$", EUR: "€", INR: "₹" };
  const sym = symbols[currency] ?? "$";
  return `${sym}${value.toFixed(2)}`;
}
