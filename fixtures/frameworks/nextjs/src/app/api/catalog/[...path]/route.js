// A catch-all beside the parameter /api/catalog/[id]: Next serves the paths of more than one segment here.
export async function GET(request, { params }) {
  const { path } = await params;
  return Response.json({ path });
}
