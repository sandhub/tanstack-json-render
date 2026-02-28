import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { streamToTextResponse } from "@tanstack-json-render/core";

export const maxDuration = 60;

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function POST(req: Request) {
  const { prompt, systemPrompt } = await req.json();

  if (!prompt) {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const stream = chat({
      adapter: anthropicText(
        process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") ||
          DEFAULT_MODEL,
      ),
      messages: [{ role: "user", content: prompt }],
      systemPrompts: [systemPrompt ?? "You are a helpful UI builder."],
      temperature: 0.7,
    });

    return streamToTextResponse(stream, CORS_HEADERS);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
}

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}
