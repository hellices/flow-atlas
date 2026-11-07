import type { APIRoute } from "astro";

export const prerender = true;

export const GET: APIRoute = () => Response.json({ name: "Astro", url: "https://astro.build/" });
