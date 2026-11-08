// The app's axios instances, as axios's guide configures them: one per service, each with its base URL.
import axios from "axios";
import { config } from "./config.js";

export const api = axios.create({
  baseURL: `${config.apiUrl}/api`,
  timeout: 5000,
  headers: { "X-Client": "web" },
});

api.interceptors.request.use((request) => {
  request.headers.Authorization = `Bearer ${config.token}`;
  return request;
});

export const billing = axios.create({ baseURL: `${config.apiUrl}/billing` });

// The billing service versions its API in the path; this client speaks v2.
billing.interceptors.request.use((request) => {
  request.url = `/v2${request.url}`;
  return request;
});
