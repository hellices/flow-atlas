// Requests to the API through the `api` instance, in the shapes of axios's guide: the method aliases, a request
// config with the method and URL, `params` for the query.
import { api } from "./http.js";

export async function listUsers(page) {
  const { data } = await api.get("/users", { params: { page, per_page: 20 } });
  return data;
}

export async function getUser(id) {
  const { data } = await api.get(`/users/${id}`);
  return data;
}

export async function createUser(user) {
  const { data } = await api.post("/users", user);
  return data;
}

export async function replaceUser(id, user) {
  const { data } = await api.put(`/users/${id}`, user);
  return data;
}

export async function renameUser(id, name) {
  const { data } = await api.patch("/users/" + id, { name });
  return data;
}

export async function deleteUser(id) {
  await api.delete(`/users/${id}`);
}

export async function signIn(credentials) {
  const { data } = await api({ method: "post", url: "/sessions", data: credentials });
  return data;
}

export async function orderItems(orderId) {
  const { data } = await api.request({ url: `/orders/${orderId}/items`, method: "get", params: { expand: "product" } });
  return data;
}
