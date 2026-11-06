import { NoteCard } from "../components/note-card";
import { SiteHeader } from "../components/site-header";

export default function Home() {
  return (
    <main>
      <SiteHeader />
      <NoteCard note={{ id: "first" }} />
    </main>
  );
}
