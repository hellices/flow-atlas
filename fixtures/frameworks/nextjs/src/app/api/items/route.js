export async function GET() {
  return Response.json([]);
}

export async function POST(request) {
  return Response.json(await request.json(), { status: 201 });
}
