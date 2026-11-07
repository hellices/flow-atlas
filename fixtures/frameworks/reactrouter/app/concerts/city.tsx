export function loader({ params }: { params: { city: string } }) {
  return { city: params.city };
}
export default function Page() {
  return <h1>City</h1>;
}
