export async function action({ request }: { request: Request }) {
  await request.text();
  return { ok: true };
}
export default function Page() {
  return <h1>Register</h1>;
}
