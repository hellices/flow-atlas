export async function GET() {
  return Response.json([]);
}

export async function POST() {
  return Response.json({ id: "new" }, { status: 201 });
}
