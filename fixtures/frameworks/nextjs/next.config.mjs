import { fileURLToPath } from "node:url";

// The application's own directory is its root, not the repository's (which has a lock file of its own).
const root = fileURLToPath(new URL(".", import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: root,
  turbopack: { root },
};
