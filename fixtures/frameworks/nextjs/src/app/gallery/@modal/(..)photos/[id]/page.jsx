// Intercepts /photos/[id] when it is reached from /gallery, to show the photo in a modal.
export default async function PhotoModal({ params }) {
  const { id } = await params;
  return <dialog open>photo {id}</dialog>;
}
