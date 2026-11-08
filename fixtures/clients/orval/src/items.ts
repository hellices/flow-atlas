// The requests the app makes, each through a function orval generates from openapi.yaml (src/api/generated.ts):
// path parameters as arguments, the query as `params`, the body as data, headers and other axios options last.
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
} from "./api/generated";

export function checkHealth() {
  // /health is served at the API's origin, outside /api/v1 (the path's own `servers` in openapi.yaml).
  return getHealth({ baseURL: location.origin });
}

export function searchItems(q: string, page: number) {
  return listItems({ q, page }, { headers: { "X-Request-Id": "list-items" } });
}

export function addItem(name: string) {
  return createItem({ name });
}

export function allowedItemMethods() {
  return itemsOptions();
}

export function loadItem(id: string) {
  return getItem(id);
}

export function saveItem(id: string, name: string) {
  return replaceItem(id, { name });
}

export function renameItem(id: string, name: string) {
  return updateItem(id, { name });
}

export function removeItem(id: string) {
  return deleteItem(id);
}

export async function hasItem(id: string) {
  await itemExists(id);
  return true;
}

export function loadUserItem(userId: string, itemId: string) {
  return getUserItem(userId, itemId);
}

export function loadReport(year: number) {
  return getReport(year);
}
