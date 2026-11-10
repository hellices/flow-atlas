// A catch-all segment: /shop/a, /shop/a/b and so on, not /shop.
export default async function Shop({ params }) {
  const { slug } = await params;
  return <h1>{slug.join("/")}</h1>;
}
