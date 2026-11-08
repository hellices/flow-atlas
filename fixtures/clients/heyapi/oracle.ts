// Makes every request the app's module makes once. A browser resolves the client's base URL, a path on the page's
// origin, against that origin; here the recording server's URL stands for it, as the page's `location` too.
import { readFileSync } from "node:fs";

const origin = process.env.RECORD_URL!;
const ARG = process.env.ARG!;
const ARG_NUMBER = Number(process.env.ARG_NUMBER);
const RealRequest = globalThis.Request;
const realFetch = globalThis.fetch;
globalThis.Request = class extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, origin) : input, init);
  }
};
globalThis.fetch = (input, init) => realFetch(typeof input === "string" ? new URL(input, origin) : input, init);
Object.defineProperty(globalThis, "location", { value: new URL(origin) });

const items: Record<string, unknown> = await import("./src/api/items");
// The arguments of each function the module exports: ARG for a string, ARG_NUMBER for a number.
const args: Record<string, unknown[]> = {
  checkHealth: [],
  searchItems: [ARG, ARG_NUMBER],
  addItem: [ARG],
  allowedItemMethods: [],
  loadItem: [ARG],
  saveItem: [ARG, ARG],
  renameItem: [ARG, ARG],
  removeItem: [ARG],
  hasItem: [ARG],
  loadUserItem: [ARG, ARG],
  loadReport: [ARG_NUMBER],
};
const unexported = Object.keys(args).filter((name) => !(name in items));
if (unexported.length) throw new Error(`not exported: ${unexported.join(", ")}`);
for (const [name, call] of Object.entries(items)) {
  if (!args[name]) throw new Error(`no arguments for ${name}`);
  try {
    await (call as (...a: unknown[]) => Promise<unknown>)(...args[name]);
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
}
const { version } = JSON.parse(readFileSync("node_modules/@hey-api/openapi-ts/package.json", "utf8")) as { version: string };
console.log(JSON.stringify({ library: "@hey-api/openapi-ts (@hey-api/client-fetch)", version }));
