// A catch-all page: /archive/a, /archive/a/b, not /archive.
export function getServerSideProps({ params }) {
  return { props: { parts: params.parts } };
}

export default function Archive({ parts }) {
  return <h1>{parts.join("/")}</h1>;
}
