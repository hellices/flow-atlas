// The generated client's configuration (openapi-ts.config.ts's `runtimeConfigPath`): the API's path on the page's
// origin instead of the server openapi.yaml names.
import type { CreateClientConfig } from "./client/client.gen";

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: "/api/v1",
});
