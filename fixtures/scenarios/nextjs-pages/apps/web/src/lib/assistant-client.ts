export async function assistantStatus(signal?: AbortSignal): Promise<{ ready: boolean }> {
  const response = await fetch("/api/assistant", { signal, cache: "no-store" });
  return (await response.json()) as { ready: boolean };
}

export async function askAssistant(draft: string): Promise<{ suggestion: string }> {
  const response = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft }),
  });
  return (await response.json()) as { suggestion: string };
}
