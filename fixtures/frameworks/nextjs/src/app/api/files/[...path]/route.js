export async function GET(request, { params }) {
  const { path } = await params;
  return Response.json({ path });
}
