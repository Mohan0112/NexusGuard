// services/notification-service/src/receipt.ts
// Fetches billing invoice over HTTP and renders a receipt
// This is the consumer that becomes AT_RISK after the cents change

const BILLING_URL = process.env["BILLING_URL"] ?? "http://localhost:3000";

export interface InvoiceResponse {
  id: string;
  subtotal: number;
  fee: number;
  total: number;       // <-- This field's unit changes with PR #104
  status: string;
}

export async function fetchInvoice(id: string): Promise<InvoiceResponse> {
  const response = await fetch(`${BILLING_URL}/invoices/${id}`);
  if (!response.ok) throw new Error(`Failed to fetch invoice ${id}`);
  return response.json() as Promise<InvoiceResponse>;
}

export function renderReceipt(inv: InvoiceResponse): string {
  // RISK: if inv.total is now in cents (not dollars), this display is wrong
  return [
    `Invoice: ${inv.id}`,
    `Subtotal: $${inv.subtotal.toFixed(2)}`,
    `Fee: $${inv.fee.toFixed(2)}`,
    `Total: $${inv.total.toFixed(2)}`,   // assumes total is in dollars
    `Status: ${inv.status}`,
  ].join("\n");
}

export async function sendReceiptEmail(invoiceId: string): Promise<string> {
  const inv = await fetchInvoice(invoiceId);
  return renderReceipt(inv);
}
