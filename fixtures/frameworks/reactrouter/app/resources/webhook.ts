export async function action({ request }: { request: Request }) {
  await request.text();
  return Response.json({ received: true });
}
