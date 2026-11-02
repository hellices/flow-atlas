export const orderScreen = (client: any, id: string) => client.get(`/screens/order/${id}`);
export const home = { path: "/screens/home", method: "GET" };
export const invoiceView = "invoice";
export const receiptView = "receipt";
