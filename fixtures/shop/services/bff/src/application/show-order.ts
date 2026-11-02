interface OrdersPort {
  getOrder(id: string): Promise<unknown>;
}

export async function showOrder(deps: { orders: OrdersPort }, id: string) {
  const order = await deps.orders.getOrder(id);
  return { order };
}
