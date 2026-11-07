export default async function Photo({ params }) {
  const { id } = await params;
  return <h1>photo {id}</h1>;
}
