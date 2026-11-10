export function loader({ params }: { params: Record<string, string | undefined> }) {
  return { path: params["*"] ?? "" };
}
export default function Page() {
  return <h1>Files</h1>;
}
