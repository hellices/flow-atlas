export async function GET(request, { params }) {
  const { id } = await params;
  return Response.json({ id });
}

export async function PUT(request, { params }) {
  const { id } = await params;
  return Response.json({ id });
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  return Response.json({ id });
}

export async function DELETE() {
  return new Response(null, { status: 204 });
}
