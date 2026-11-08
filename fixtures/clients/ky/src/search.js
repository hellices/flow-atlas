// Requests through the `search` instance, whose `baseUrl` resolves each input as a URL.
import { search } from "./http.js";

export const searchItems = (term) => search.get("items", { searchParams: { q: term } }).json();

export const querySearch = (term) => search.query("items", { json: { term, limit: 20 } }).json();

// A leading slash resolves against the origin, not the base's path.
export const searchStatus = () => search.get("/status").json();
