export function loader({ params }: { params: { id: string } }) {
  return new Response(`report ${params.id}`, { headers: { "Content-Type": "application/pdf" } });
}
