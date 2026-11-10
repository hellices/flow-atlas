import { create } from "./server.js";

const server = await create();
await server.start();
console.log("Server running on %s", server.info.uri);
