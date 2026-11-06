/** Every path of the notes API is under its version; a path given with the version already in it is kept. */
function apiPath(path: string): string {
  return path.startsWith("/api/v1") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}

/** A client of the notes API. Its base URL is the server's origin; `apiPath` puts the version before each path. */
export class NotesApiClient {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${apiPath(path)}`, init);
    return response.json();
  }

  listNotebooks(): Promise<unknown> {
    return this.request("/notebooks");
  }

  search(notebookId: string, query: string): Promise<unknown> {
    return this.request(`/notebooks/${encodeURIComponent(notebookId)}/search`, { method: "POST", body: JSON.stringify({ query }) });
  }
}
