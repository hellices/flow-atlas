import type { APIRoute } from "astro";

export const GET: APIRoute = () => new Response("<urlset/>", { headers: { "Content-Type": "application/xml" } });
