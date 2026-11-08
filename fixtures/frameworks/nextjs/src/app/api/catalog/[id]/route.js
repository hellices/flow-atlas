// A parameter beside the catch-all /api/catalog/[...path]: Next serves a path of one segment here, before the catch-all.
export async function GET(request, { params }) {
  const { id } = await params;
  return Response.json({ id });
}
