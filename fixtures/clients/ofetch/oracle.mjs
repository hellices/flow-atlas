// Makes every request the app's modules make once. The app reads the API's URL from its environment (src/config.js);
// the recording server's URL stands for it. A page resolves `$fetch`'s relative paths against its origin; here the
// recording server's URL stands for that too.
import { readFileSync } from "node:fs";

const origin = process.env.RECORD_URL;
process.env.API_BASE = origin;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(typeof input === "string" ? new URL(input, origin) : input, init);

for (const file of ["./src/users.js", "./src/catalog.js", "./src/session.js"]) {
  const module = await import(file);
  for (const [name, call] of Object.entries(module)) {
    try {
      await call(process.env.ARG, process.env.ARG);
    } catch (error) {
      throw new Error(`${file} ${name}: ${error.message}`);
    }
  }
}
const { version } = JSON.parse(readFileSync(new URL("node_modules/ofetch/package.json", import.meta.url), "utf8"));
console.log(JSON.stringify({ library: "ofetch", version }));
