export interface BffRequest {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}

export interface BffClient {
  request<T>(request: BffRequest): Promise<T>;
}

export function createBffClient(baseUrl: string, fetcher: typeof fetch): BffClient {
  return {
    async request<T>(request: BffRequest): Promise<T> {
      const method = request.method ?? "GET";
      if (!request.path.startsWith("/")) throw new Error("BFF paths are relative to the base URL");
      const response = await fetcher(`${baseUrl}${request.path}`, {
        method,
        headers: {
          accept: "application/json",
          // Only a new interaction says which cards the app can show.
          ...(request.path === "/interactions" && method === "POST" ? { "x-card-capabilities": "v2" } : {}),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      return (await response.json()) as T;
    },
  };
}
