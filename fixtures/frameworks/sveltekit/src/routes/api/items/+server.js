/** @type {import('./$types').RequestHandler} */
export function GET() {
	return Response.json([]);
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	return Response.json({ created: await request.text() }, { status: 201 });
}
