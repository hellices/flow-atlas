/** @type {import('./$types').RequestHandler} */
export function GET({ params }) {
	return Response.json({ path: params.path });
}
