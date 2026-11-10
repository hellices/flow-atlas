export function loader() {
  return Response.json({ message: "I handle GET" });
}

export async function action({ request }: { request: Request }) {
  await request.text();
  return Response.json({ message: "I handle everything else" });
}
