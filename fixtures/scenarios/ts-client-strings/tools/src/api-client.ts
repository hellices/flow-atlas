/** A client of the notes API. Its base URL ends in /api/v1; the paths it is given are relative to it. */
export class NotesApiClient {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (path.startsWith("/api/v1")) throw new Error("paths are relative to the base URL, which ends in the API version");
    const response = await fetch(`${this.baseUrl}${path}`, init);
    return response.json();
  }

  listNotebooks(): Promise<unknown> {
    return this.request("/notebooks");
  }

  search(notebookId: string, query: string): Promise<unknown> {
    return this.request(`/notebooks/${encodeURIComponent(notebookId)}/search`, { method: "POST", body: JSON.stringify({ query }) });
  }
}
