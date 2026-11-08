// Makes every request the app's modules make once. The app reads the API's URL from its environment (src/config.js);
// the recording server's URL stands for it.
import { readFileSync } from "node:fs";

process.env.API_URL = process.env.RECORD_URL;
for (const file of ["./src/users.js", "./src/admin.js", "./src/search.js"]) {
  const module = await import(file);
  for (const [name, call] of Object.entries(module)) {
    try {
      await call(process.env.ARG, process.env.ARG);
    } catch (error) {
      throw new Error(`${file} ${name}: ${error.message}`);
    }
  }
}
const { version } = JSON.parse(readFileSync(new URL("node_modules/ky/package.json", import.meta.url), "utf8"));
console.log(JSON.stringify({ library: "ky", version }));
