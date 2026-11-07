/** @type {import('./$types').RequestHandler} */
export function GET({ params }) {
	return Response.json({ id: params.id });
}

/** @type {import('./$types').RequestHandler} */
export function PUT({ params }) {
	return Response.json({ updated: params.id });
}

/** @type {import('./$types').RequestHandler} */
export function DELETE({ params }) {
	return new Response(null, { status: 204 });
}
