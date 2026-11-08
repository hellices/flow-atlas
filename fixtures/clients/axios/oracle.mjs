// Makes every request the app's modules make once. The app reads the API's URL from its environment (src/config.js);
// the recording server's URL stands for it.
process.env.API_URL = process.env.RECORD_URL;
const { default: axios } = await import("axios");

// Arguments that are numbers in the app: an invoice's number.
const numeric = new Set(["getInvoice", "payInvoice"]);
for (const file of ["./src/users.js", "./src/billing.js", "./src/status.js"]) {
  const module = await import(file);
  for (const [name, call] of Object.entries(module)) {
    const arg = numeric.has(name) ? Number(process.env.ARG_NUMBER) : process.env.ARG;
    try {
      await call(arg, process.env.ARG);
    } catch (error) {
      throw new Error(`${file} ${name}: ${error.message}`);
    }
  }
}
console.log(JSON.stringify({ library: "axios", version: axios.VERSION }));
