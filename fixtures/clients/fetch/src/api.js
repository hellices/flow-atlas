// Requests a browser app makes with the Fetch API, in the shapes MDN's "Using the Fetch API" guide shows: a URL
// relative to the page's origin, a template or a concatenation with a value in it, a method and a body in the init
// object, a Request object, a query string.
const API = "/api/v2";

export async function health() {
  const response = await fetch("/api/health");
  return response.json();
}

export async function getUser(id) {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

export async function createUser(user) {
  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  return response.json();
}

export async function replaceUser(id, user) {
  return fetch(`/api/users/${id}`, { method: "PUT", body: JSON.stringify(user) });
}

export async function renameUser(id, name) {
  return fetch(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function deleteUser(id) {
  return fetch("/api/users/" + id, { method: "DELETE" });
}

export async function orderItems(orderId) {
  const response = await fetch("/api/orders/" + orderId + "/items");
  return response.json();
}

export async function report(year) {
  const response = await fetch(`${API}/reports/${year}`);
  return response.json();
}

export async function search(term, page) {
  const response = await fetch(`/api/search?q=${encodeURIComponent(term)}&page=${page}`);
  return response.json();
}

export async function upload(file) {
  const request = new Request("/api/uploads", { method: "POST", body: file });
  return fetch(request);
}
