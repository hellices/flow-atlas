export interface StoreSharesOptions {
  baseUrl: string;
  fetch: typeof fetch;
}

/** The storage service's v2 operations all take a POST under one base. */
export function createStoreShares(options: StoreSharesOptions) {
  const base = `${options.baseUrl.replace(/\/+$/, "")}/store/internal/v2`;
  async function send(route: string, request: unknown): Promise<unknown> {
    const response = await options.fetch(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return response.json();
  }
  return {
    publish: (request: unknown) => send("shares", request),
    ticketUpload: (request: unknown) => send("upload-tickets", request),
  };
}
