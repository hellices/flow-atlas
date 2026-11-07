/** @type {import('./$types').RequestHandler} */
export async function PUT({ request }) {
	return Response.json({ received: await request.text() });
}
