/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	return Response.json({ echo: await request.text() });
}

/** @type {import('./$types').RequestHandler} */
export async function fallback({ request }) {
	return new Response(`I caught your ${request.method} request!`);
}
