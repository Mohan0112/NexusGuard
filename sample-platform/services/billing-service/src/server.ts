// services/billing-service/src/server.ts
// Minimal Express-like route for demo purposes (no actual Express dep — just the pattern)
import { buildInvoice } from "./invoice.js";

// Simulated route handler: GET /invoices/:id
export function handleGetInvoice(id: string, subtotal: number) {
  const invoice = buildInvoice(id, subtotal);
  // res.json(invoice)  <-- route contract: { id, subtotal, fee, total, status }
  return invoice;
}
