/** A link to a page that shows what the payload carries, in the fragment so it never reaches a server. */
function linkFor(path: "/m" | "/r", payload: string, origin: string): string {
  const url = new URL(path, origin);
  url.hash = payload;
  return url.toString();
}

export const makeMessageLink = (payload: string, origin: string) => linkFor("/m", payload, origin);

export const makeResponseLink = (payload: string, origin: string) => linkFor("/r", payload, origin);
