// Requests through the `admin` instance, extended from `api`.
import { admin } from "./http.js";

export const auditLog = (userId) => admin.get(`users/${userId}/audit`, { searchParams: { limit: 50 } }).json();

export const suspendUser = (userId) => admin.post(`users/${userId}/suspend`).json();
