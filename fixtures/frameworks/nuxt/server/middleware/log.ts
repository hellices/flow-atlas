export default defineEventHandler((event) => {
  event.context.requestedAt = Date.now()
})
