export default function ContentPage({ params }: { params: { slug: string[] } }) {
  return <article>{params.slug.length}</article>;
}
