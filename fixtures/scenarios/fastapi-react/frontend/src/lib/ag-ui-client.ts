export function chatEndpoint(base?: string): string {
  return base ? `${base}/api/chat` : "/api/chat";
}
