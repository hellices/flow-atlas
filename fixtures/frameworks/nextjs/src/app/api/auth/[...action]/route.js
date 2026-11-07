// One handler for two methods, exported under each method's name.
async function handler(request, { params }) {
  const { action } = await params;
  return Response.json({ action, method: request.method });
}

export { handler as GET, handler as POST };
