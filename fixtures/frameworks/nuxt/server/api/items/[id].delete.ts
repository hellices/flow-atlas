export default defineEventHandler((event) => ({ deleted: getRouterParam(event, 'id') }))
