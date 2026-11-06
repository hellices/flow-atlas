"use client";

import Link from "next/link";
import { askAssistant } from "../lib/assistant-client";

export function Studio() {
  const suggest = (draft: string) => askAssistant(draft);
  return (
    <main>
      <footer>
        <Link href="/create/manual">Prefer to write it yourself?</Link>
      </footer>
    </main>
  );
}
