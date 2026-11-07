import { createApp } from './app.js';

const app = await createApp();
await app.listen(process.env.PORT ?? 3000);
