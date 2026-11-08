// Requests with `$fetch`, ofetch's default instance, from a page: a path relative to the page's origin.
import { $fetch } from "ofetch";

export const login = (credentials) => $fetch("/auth/login", { method: "POST", body: credentials });

export const session = () => $fetch("/auth/session");

export const logout = () => $fetch("/auth/logout", { method: "POST" });

export const search = (term) => $fetch("/api/search", { query: { q: term, limit: 10 } });
