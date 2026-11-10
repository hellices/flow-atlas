// Requests through the `catalog` instance, the catalog service's own base path.
import { catalog } from "./http.js";

export const listProducts = (category) => catalog("/products", { query: { category } });

export const getProduct = (sku) => catalog(`/products/${sku}`);

export const reviewProduct = (sku, review) => catalog(`/products/${sku}/reviews`, { method: "POST", body: review });
