export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ clientId: process.env.PUBLIC_CLIENT_ID });
}
