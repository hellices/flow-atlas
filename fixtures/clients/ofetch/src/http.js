// The app's ofetch instances, as ofetch's readme configures them: `ofetch.create` with a `baseURL` and shared
// interceptors, one per service.
import { ofetch } from "ofetch";
import { config } from "./config.js";

export const api = ofetch.create({
  baseURL: `${config.apiBase}/api`,
  headers: { "X-Client": "web" },
  onRequest({ options }) {
    options.headers.set("Authorization", `Bearer ${config.token}`);
  },
});

export const catalog = ofetch.create({ baseURL: `${config.apiBase}/catalog/v1` });
