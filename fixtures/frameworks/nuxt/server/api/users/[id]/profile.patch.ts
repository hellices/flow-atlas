export default defineEventHandler((event) => ({ patched: getRouterParam(event, 'id') }))
