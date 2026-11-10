// A dynamic segment beside the catch-all of /shop/[...slug]: Next serves /shop/a here, /shop/a/b there.
export default async function Category({ params }) {
  const { category } = await params;
  return <h1>{category}</h1>;
}
