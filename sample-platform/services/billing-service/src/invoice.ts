// services/billing-service/src/invoice.ts
import { calculateFee } from "@sample/shared-pricing";

export function buildInvoice(id: string, subtotal: number) {
  const fee = calculateFee(subtotal);
  return {
    id,
    subtotal,
    fee,
    total: subtotal + fee,   // fee is in dollars — total is in dollars
    status: "OPEN" as const,
  };
}
