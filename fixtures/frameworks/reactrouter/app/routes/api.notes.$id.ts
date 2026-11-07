export function loader({ params }: { params: { id: string } }) {
  return Response.json({ id: params.id });
}

export async function action({ request, params }: { request: Request; params: { id: string } }) {
  await request.text();
  return Response.json({ id: params.id, method: request.method });
}
