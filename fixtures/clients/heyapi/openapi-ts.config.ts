import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "openapi.yaml",
  output: "src/client",
  plugins: [
    { name: "@hey-api/client-fetch", runtimeConfigPath: "./src/hey-api.ts" },
    "@hey-api/sdk",
    "@hey-api/typescript",
  ],
});
