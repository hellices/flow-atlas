export function loader({ params }: { params: { slug: string } }) {
  return { slug: params.slug };
}
export default function Page() {
  return <h1>Post</h1>;
}
