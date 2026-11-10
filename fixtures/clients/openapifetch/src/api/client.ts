// The app's API client, as openapi-fetch's guide sets one up: typed by the paths openapi-typescript generates from
// openapi.yaml (src/api/v1.d.ts), its base URL the API's path on the page's origin, a middleware for the token.
import createClient, { type Middleware, wrapAsPathBasedClient } from "openapi-fetch";
import type { paths } from "./v1";

const auth: Middleware = {
  async onRequest({ request }) {
    request.headers.set("Authorization", "Bearer token");
    return request;
  },
};

export const client = createClient<paths>({ baseUrl: "/api/v1/", headers: { Accept: "application/json" } });
client.use(auth);

export const pathClient = wrapAsPathBasedClient(client);
