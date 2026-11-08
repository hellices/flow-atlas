// The requests the app makes, each through the typed client: the path as the document names it, the path parameters,
// query and headers in `params`, the body in `body`.
import { client, pathClient } from "./client";

export async function health() {
  // /health is served at the API's origin, outside /api/v1 (the path's own `servers` in openapi.yaml).
  const { data } = await client.GET("/health", { baseUrl: "/" });
  return data;
}

export async function listItems(q: string, page: number) {
  const { data, error } = await client.GET("/items", {
    params: { query: { q, page }, header: { "X-Request-Id": "list-items" } },
  });
  if (error) throw new Error("could not list the items");
  return data;
}

export async function createItem(name: string) {
  const { data } = await client.POST("/items", { body: { name } });
  return data;
}

export async function itemsOptions() {
  const { response } = await client.OPTIONS("/items");
  return response.headers.get("Allow");
}

export async function getItem(id: string) {
  const { data } = await client.GET("/items/{id}", { params: { path: { id } } });
  return data;
}

export async function replaceItem(id: string, name: string) {
  const { data } = await client.PUT("/items/{id}", { params: { path: { id } }, body: { name } });
  return data;
}

export async function renameItem(id: string, name: string) {
  const { data } = await client.PATCH("/items/{id}", { params: { path: { id } }, body: { name } });
  return data;
}

export async function deleteItem(id: string) {
  await client.DELETE("/items/{id}", { params: { path: { id } } });
}

export async function itemExists(id: string) {
  const { response } = await client.HEAD("/items/{id}", { params: { path: { id } } });
  return response.ok;
}

export async function getUserItem(userId: string, itemId: string) {
  const { data } = await pathClient["/users/{userId}/items/{itemId}"].GET({ params: { path: { userId, itemId } } });
  return data;
}

export async function getReport(year: number) {
  const { data } = await client.GET("/reports/{year}", { params: { path: { year } } });
  return data;
}
