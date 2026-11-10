import type { APIRoute } from "astro";

export const GET: APIRoute = () => Response.json([{ id: 1 }]);

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  return Response.json(body, { status: 201 });
};
