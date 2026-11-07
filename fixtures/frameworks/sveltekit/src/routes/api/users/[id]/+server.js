/** @type {import('./$types').RequestHandler} */
export function PATCH({ params }) {
	return Response.json({ patched: params.id });
}
