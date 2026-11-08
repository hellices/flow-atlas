// A static segment beside the parameter of /api/items/[id]: Next serves /api/items/export here, for GET alone.
export async function GET() {
  return new Response("id\n", { headers: { "content-type": "text/csv" } });
}
