export async function GET(request, { params }) {
  const { filters } = await params;
  return Response.json({ filters: filters ?? [] });
}
