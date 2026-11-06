import { NotePlayer } from "../../../components/note-player";

export default async function NotePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <NotePlayer id={slug} />;
}
