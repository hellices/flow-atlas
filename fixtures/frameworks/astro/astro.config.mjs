import node from "@astrojs/node";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  build: { inlineStylesheets: "never" },
  redirects: {
    "/old-about": "/about",
    "/articles/[...slug]": "/docs/[...slug]",
    "/news": { status: 302, destination: "/blog" },
  },
});
