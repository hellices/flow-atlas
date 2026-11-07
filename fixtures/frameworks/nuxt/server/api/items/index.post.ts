export default defineEventHandler(async (event) => ({ created: await readBody(event) }))
