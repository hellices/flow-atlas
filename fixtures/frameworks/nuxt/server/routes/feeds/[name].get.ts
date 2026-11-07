export default defineEventHandler((event) => ({ feed: getRouterParam(event, 'name') }))
