"use client";

import { useRouter } from "next/navigation";

export function PostCreateButton() {
  const router = useRouter();
  async function onClick() {
    const response = await fetch("/api/posts", { method: "POST" });
    const post = await response.json();
    router.push(`/editor/${post.id}`);
  }
  return <button onClick={onClick}>New post</button>;
}
