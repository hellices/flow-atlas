export default async function Member({ params }) {
  const { team, member } = await params;
  return <h1>{member} of {team}</h1>;
}
