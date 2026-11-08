// The requests the app makes, each through a function of the SDK @hey-api/openapi-ts generates from openapi.yaml
// (src/client/sdk.gen.ts): path parameters in `path`, the query in `query`, headers and the body as named.
import { client } from "../client/client.gen";
import {
  createItem,
  deleteItem,
  getHealth,
  getItem,
  getReport,
  getUserItem,
  itemExists,
  itemsOptions,
  listItems,
  replaceItem,
  updateItem,
} from "../client/sdk.gen";

client.interceptors.request.use((request) => {
  request.headers.set("Authorization", "Bearer token");
  return request;
});

export async function checkHealth() {
  // /health is served at the API's origin, outside /api/v1 (the path's own `servers` in openapi.yaml).
  const { data } = await getHealth({ baseUrl: location.origin });
  return data;
}

export async function searchItems(q: string, page: number) {
  const { data } = await listItems({ query: { q, page }, headers: { "X-Request-Id": "list-items" }, throwOnError: true });
  return data;
}

export async function addItem(name: string) {
  const { data } = await createItem({ body: { name } });
  return data;
}

export async function allowedItemMethods() {
  const { response } = await itemsOptions();
  return response?.headers.get("Allow");
}

export async function loadItem(id: string) {
  const { data } = await getItem({ path: { id } });
  return data;
}

export async function saveItem(id: string, name: string) {
  const { data } = await replaceItem({ path: { id }, body: { name } });
  return data;
}

export async function renameItem(id: string, name: string) {
  const { data } = await updateItem({ path: { id }, body: { name } });
  return data;
}

export async function removeItem(id: string) {
  await deleteItem({ path: { id } });
}

export async function hasItem(id: string) {
  const { response } = await itemExists({ path: { id } });
  return response?.ok ?? false;
}

export async function loadUserItem(userId: string, itemId: string) {
  const { data } = await getUserItem({ path: { userId, itemId } });
  return data;
}

export async function loadReport(year: number) {
  const { data } = await getReport({ path: { year } });
  return data;
}
