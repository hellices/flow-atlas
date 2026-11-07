export async function action({ request }: { request: Request }) {
  await request.text();
  return { sent: true };
}
export default function Page() {
  return <h1>Contact</h1>;
}
