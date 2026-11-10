// An optional catch-all page: /wiki as well as /wiki/a, /wiki/a/b.
export function getServerSideProps({ params }) {
  return { props: { path: params.path ?? [] } };
}

export default function Wiki({ path }) {
  return <h1>{path.join("/") || "wiki"}</h1>;
}
