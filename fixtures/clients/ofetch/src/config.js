// Where the API is served, as the app's environment sets it.
export const config = {
  apiBase: process.env.API_BASE ?? "http://localhost:8080",
  token: process.env.API_TOKEN ?? "dev-token",
};
