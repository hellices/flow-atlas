export async function getOrder(baseUrl: string, id: string) {
  return fetch(`${baseUrl}/orders/${encodeURIComponent(id)}`);
}

export async function createOrder(baseUrl: string) {
  return fetch(`${baseUrl}/orders`, { method: "POST" });
}

export function followUpdates(baseUrl: string) {
  return new EventSource(`${baseUrl}/order-updates`);
}

export async function refund(baseUrl: string, id: string) {
  return fetch(`${baseUrl}/orders/${id}/refund`, { method: "POST" });
}

export const logo = "/assets/logo.png";
