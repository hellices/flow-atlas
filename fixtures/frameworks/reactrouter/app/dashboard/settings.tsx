export async function action({ request }: { request: Request }) {
  await request.text();
  return { saved: true };
}
export default function Page() {
  return <h1>Settings</h1>;
}
