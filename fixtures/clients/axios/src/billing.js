// Requests to the billing service through its own instance.
import { billing } from "./http.js";

export async function listInvoices(customerId) {
  const { data } = await billing.get(`/customers/${customerId}/invoices`, { params: { status: "open" } });
  return data;
}

export async function getInvoice(number) {
  const { data } = await billing.get(`/invoices/${number}`);
  return data;
}

export async function payInvoice(number, payment) {
  const { data } = await billing.post(`/invoices/${number}/payments`, payment);
  return data;
}
