export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await acquireToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

declare function acquireToken(): Promise<string>;
