// Makes every request the app's API slices make once. The slices are compiled by `npm run build` (tsc) and used
// through the app's own store, as RTK Query's "Usage Without React Hooks" guide does: each endpoint's `initiate` is
// dispatched with ARG (ARG_NUMBER where it takes a number, an object of them where it takes one). fetchBaseQuery's
// base URLs are relative, which a browser resolves against the page's origin; the recording server's URL stands for it.
import { createRequire } from "node:module";

const origin = process.env.RECORD_URL;
const realFetch = globalThis.fetch;
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === "string" ? new URL(input, origin) : input, init);
  }
};
globalThis.fetch = (input, init) => realFetch(typeof input === "string" ? new URL(input, origin) : input, init);

const require = createRequire(import.meta.url);
const { store } = require("./dist/store.js");
const { setToken } = require("./dist/features/auth/authSlice.js");
const { api } = require("./dist/services/api.js");
const { reportsApi } = require("./dist/services/reports.js");
require("./dist/services/users.js");

const ARG = process.env.ARG;
const NUMBER = Number(process.env.ARG_NUMBER);
/** The argument of each endpoint that does not take one string. */
const args = {
  getHealth: undefined,
  getPosts: NUMBER,
  updatePost: { id: ARG, title: ARG },
  replacePost: { id: ARG, title: ARG, body: ARG },
  getReport: NUMBER,
  exportReport: { year: NUMBER, format: ARG },
};

store.dispatch(setToken(ARG));
for (const slice of [api, reportsApi]) {
  for (const [name, endpoint] of Object.entries(slice.endpoints)) {
    const result = await store.dispatch(endpoint.initiate(name in args ? args[name] : ARG));
    // A response the endpoint cannot decode was still sent; any other error means no request went out.
    if (result.error && result.error.status !== "PARSING_ERROR") throw new Error(`${slice.reducerPath}.${name}: ${JSON.stringify(result.error)}`);
  }
}
const { version } = require("@reduxjs/toolkit/package.json");
// The cache keeps each result's timer running after the requests; exit once the line is written.
process.stdout.write(`${JSON.stringify({ library: "RTK Query (@reduxjs/toolkit)", version })}\n`, () => process.exit(0));
