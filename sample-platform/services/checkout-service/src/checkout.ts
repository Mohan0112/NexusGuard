// services/checkout-service/src/checkout.ts
// NEGATIVE CONTROL: imports shared-pricing but only uses formatMoney + CurrencyCode
// Does NOT use calculateFee → should be IMPORT_ONLY_UNAFFECTED (green)

import { formatMoney, type CurrencyCode } from "@sample/shared-pricing";

export function displayCartTotal(total: number, currency: CurrencyCode): string {
  return `Your total: ${formatMoney(total, currency)}`;
}

export function getAvailableCurrencies(): CurrencyCode[] {
  return ["USD", "EUR", "INR"];
}
