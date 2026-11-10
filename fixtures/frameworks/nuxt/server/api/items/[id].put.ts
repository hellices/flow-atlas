export default defineEventHandler((event) => ({ updated: getRouterParam(event, 'id') }))
