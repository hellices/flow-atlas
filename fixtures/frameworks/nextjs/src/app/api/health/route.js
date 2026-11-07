export const GET = () => Response.json({ status: "ok" });

export function HEAD() {
  return new Response(null, { status: 200 });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } });
}
