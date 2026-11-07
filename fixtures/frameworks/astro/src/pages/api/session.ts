import type { APIRoute } from "astro";

export const GET: APIRoute = () => Response.json({ user: null });

export const ALL: APIRoute = ({ request }) => Response.json({ method: request.method });
