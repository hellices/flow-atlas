// A static segment beside the catch-all of /api/auth/[...action], which takes POST too.
export async function GET() {
  return Response.json({ user: null });
}
