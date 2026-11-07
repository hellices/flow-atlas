import type { APIRoute } from "astro";

export const ALL: APIRoute = ({ request }) => Response.json({ method: request.method });
