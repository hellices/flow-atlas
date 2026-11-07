export default async function Post({ params }) {
  const { slug } = await params;
  return <h1>{slug}</h1>;
}
