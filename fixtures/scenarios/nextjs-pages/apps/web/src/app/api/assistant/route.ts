export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return Response.json({ ready: true, url: request.url });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { draft: string };
  return Response.json({ suggestion: body.draft });
}
