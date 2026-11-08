// Requests through the `api` instance, in the shapes of Ky's readme: the method shortcuts with a body shortcut,
// `json` for the body, `searchParams` for the query, `method` in the options.
import { api } from "./http.js";

export const listUsers = (page) => api.get("users", { searchParams: { page, per_page: 20 } }).json();

export const getUser = (id) => api.get(`users/${id}`).json();

export const createUser = (user) => api.post("users", { json: user }).json();

export const replaceUser = (id, user) => api.put(`users/${id}`, { json: user }).json();

export const renameUser = (id, name) => api.patch("users/" + id, { json: { name } }).json();

export async function deleteUser(id) {
  await api.delete(`users/${id}`);
}

// A prefix ignores the input's leading slash.
export async function userExists(id) {
  const response = await api.head(`/users/${id}`, { throwHttpErrors: false });
  return response.ok;
}

export const signIn = (credentials) => api("sessions", { method: "post", json: credentials }).json();
