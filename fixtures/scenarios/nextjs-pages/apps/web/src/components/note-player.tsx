"use client";

import Link from "next/link";

export function NotePlayer({ id, next }: { id: string; next?: { id: string } }) {
  return (
    <div data-note={id}>
      {next && <Link href={`/notes/${next.id}`}>Try another</Link>}
      <Link href="/create">Write your own</Link>
    </div>
  );
}
