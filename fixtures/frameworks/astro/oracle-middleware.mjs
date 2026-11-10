// Added by oracle.mjs through Astro's `addMiddleware`, after the application's own: each response Astro renders names the
// route that rendered it (`context.routePattern`), so the oracle knows which route a request reached.
export async function onRequest(context, next) {
  const response = await next();
  const tagged = new Response(response.body, response);
  tagged.headers.set("x-oracle-route", context.routePattern);
  return tagged;
}
