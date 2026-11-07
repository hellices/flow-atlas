import type { APIRoute } from "astro";

export const GET: APIRoute = ({ params }) => Response.json({ id: params.id });
