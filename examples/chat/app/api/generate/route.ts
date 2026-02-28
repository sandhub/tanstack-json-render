import { createAgentStream } from "@/lib/agent";
import { toServerSentEventsResponse } from "@tanstack/ai";
import { pipeJsonRender } from "@json-render/core";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const messages: Array<{ role: string; content: string }> = body.messages;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const raw = createAgentStream(messages);
  return toServerSentEventsResponse(pipeJsonRender(raw));
}
