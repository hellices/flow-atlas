import Link from "next/link";

export function NoteCard({ note }: { note: { id: string } }) {
  return (
    <Link href={`/notes/${note.id}`} className="note-card">
      open
    </Link>
  );
}
