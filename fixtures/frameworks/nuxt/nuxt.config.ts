export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  devtools: { enabled: false },
  telemetry: false,
  serverHandlers: [
    { route: '/api/legacy', method: 'get', handler: '~~/server/handlers/legacy.ts' },
  ],
})
