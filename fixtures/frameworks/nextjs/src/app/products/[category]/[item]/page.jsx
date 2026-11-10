export default async function Product({ params }) {
  const { category, item } = await params;
  return <h1>{category}/{item}</h1>;
}
