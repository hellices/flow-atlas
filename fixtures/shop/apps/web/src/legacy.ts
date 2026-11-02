export async function directOrder(ordersUrl: string, id: string) {
  return fetch(`${ordersUrl}/orders/${id}`);
}
