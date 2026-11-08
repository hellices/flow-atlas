// The app's Ky instances, as Ky's readme configures them: `ky.create` with a `prefix` or a `baseUrl`, `extend` for a
// niche of the API with its parent's defaults.
import ky from "ky";
import { API_TOKEN, API_URL } from "./config.js";

export const api = ky.create({
  prefix: `${API_URL}/api`,
  headers: { "X-Client": "web" },
  hooks: {
    beforeRequest: [
      ({ request }) => {
        request.headers.set("Authorization", `Bearer ${API_TOKEN}`);
      },
    ],
  },
});

// The admin endpoints, under the API's prefix.
export const admin = api.extend((options) => ({ prefix: `${options.prefix}/admin` }));

// The search service. A `baseUrl` resolves the input as a URL: a page-relative path extends the base's path, one with a
// leading slash starts from the origin.
export const search = ky.create({ baseUrl: `${API_URL}/search/` });
