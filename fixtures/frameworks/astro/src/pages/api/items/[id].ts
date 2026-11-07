import type { APIRoute } from "astro";

export const GET: APIRoute = ({ params }) => Response.json({ id: params.id });

export const PUT: APIRoute = ({ params }) => Response.json({ id: params.id, replaced: true });

export const PATCH: APIRoute = ({ params }) => Response.json({ id: params.id, updated: true });

export const DELETE: APIRoute = () => new Response(null, { status: 204 });
