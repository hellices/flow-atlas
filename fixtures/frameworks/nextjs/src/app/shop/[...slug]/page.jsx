// A catch-all segment: /shop/a/b and so on, not /shop; /shop/a goes to /shop/[category] beside it.
export default async function Shop({ params }) {
  const { slug } = await params;
  return <h1>{slug.join("/")}</h1>;
}
