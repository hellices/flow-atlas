import { defineConfig } from "orval";

export default defineConfig({
  items: {
    input: "./openapi.yaml",
    output: {
      mode: "single",
      target: "src/api/generated.ts",
      client: "axios-functions",
      override: {
        mutator: { path: "src/api/mutator/custom-instance.ts", name: "customInstance" },
      },
    },
  },
});
