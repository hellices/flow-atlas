// An optional catch-all segment: /docs as well as /docs/a, /docs/a/b and so on.
export default async function Docs({ params }) {
  const { slug } = await params;
  return <h1>{slug ? slug.join("/") : "docs"}</h1>;
}
