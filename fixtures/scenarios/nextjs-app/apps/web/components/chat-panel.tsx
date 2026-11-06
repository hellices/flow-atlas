"use client";

export function ChatPanel({ token }: { token: string }) {
  const ask = (input: string) =>
    fetch("/api/chat/stream", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ input }),
    });
  return null;
}
