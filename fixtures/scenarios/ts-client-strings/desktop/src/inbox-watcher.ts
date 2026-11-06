export async function inboxItems(): Promise<string[]> {
  const response = await fetch("http://127.0.0.1:4800/inbox/items", { method: "GET" });
  return response.ok ? ((await response.json()) as string[]) : [];
}
