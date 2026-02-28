import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { streamToTextResponse } from "@tanstack-json-render/core";
import { getVideoPrompt } from "@/lib/catalog";

export const maxDuration = 30;

// Generate prompt from catalog - uses Remotion schema's prompt template with custom rules
const SYSTEM_PROMPT = getVideoPrompt();

const MAX_PROMPT_LENGTH = 500;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const sanitizedPrompt = String(prompt || "").slice(0, MAX_PROMPT_LENGTH);

  const stream = chat({
    adapter: anthropicText(
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") ||
        DEFAULT_MODEL,
    ),
    messages: [{ role: "user", content: sanitizedPrompt }],
    systemPrompts: [SYSTEM_PROMPT],
    temperature: 0.7,
  });

  return streamToTextResponse(stream);
}
