// Requests through the `api` instance, in the shapes of ofetch's readme: `method` and an object `body` in the options,
// `query` for the query, `.raw` for the response itself.
import { api } from "./http.js";

export const listUsers = (page) => api("/users", { query: { page, per_page: 20 } });

export const getUser = (id) => api(`/users/${id}`);

export const createUser = (user) => api("/users", { method: "POST", body: user });

export const replaceUser = (id, user) => api(`/users/${id}`, { method: "PUT", body: user });

export const renameUser = (id, name) => api("/users/" + id, { method: "PATCH", body: { name } });

export const deleteUser = (id) => api(`/users/${id}`, { method: "DELETE" });

export async function userAvatar(id) {
  const response = await api.raw(`/users/${id}/avatar`, { responseType: "blob" });
  return response._data;
}
