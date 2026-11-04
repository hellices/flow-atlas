export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await acquireToken();
  return fetch(input, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
}

declare function acquireToken(): Promise<string>;
