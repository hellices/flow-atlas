export default function EditorPage({ params }: { params: { postId: string } }) {
  return <form id={params.postId} />;
}
