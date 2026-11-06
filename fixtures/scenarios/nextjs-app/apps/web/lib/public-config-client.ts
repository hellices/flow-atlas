export async function loadPublicConfig(): Promise<{ clientId: string }> {
  const response = await fetch("/api/public-config", { cache: "no-store" });
  return response.json();
}
