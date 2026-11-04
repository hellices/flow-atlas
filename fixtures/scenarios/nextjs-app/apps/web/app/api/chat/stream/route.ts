import { handleChatStreamRequest } from "@/lib/chat-stream";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleChatStreamRequest(request);
}
