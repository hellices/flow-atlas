// Makes every request the app's modules make once. A browser resolves a relative URL against the page's origin; here
// the recording server's URL stands for it.
const origin = process.env.RECORD_URL;
const realFetch = globalThis.fetch;
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === "string" ? new URL(input, origin) : input, init);
  }
};
globalThis.fetch = (input, init) => realFetch(typeof input === "string" ? new URL(input, origin) : input, init);

for (const file of ["./src/api.js", "./src/projects.js"]) {
  const module = await import(file);
  for (const [name, call] of Object.entries(module)) {
    try {
      await call(process.env.ARG, process.env.ARG);
    } catch (error) {
      throw new Error(`${file} ${name}: ${error.message}`);
    }
  }
}
console.log(JSON.stringify({ library: "fetch (undici)", version: process.versions.undici }));
