import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import {
  buildUserPrompt,
  streamToTextResponse,
} from "@tanstack-json-render/core";
import { dashboardCatalog } from "@/lib/render/catalog";

export const maxDuration = 30;

const SYSTEM_PROMPT = dashboardCatalog.prompt();

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  const { prompt, context } = await req.json();

  const userPrompt = buildUserPrompt({
    prompt,
    state: context?.state,
  });

  const stream = chat({
    adapter: anthropicText(
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") ||
        DEFAULT_MODEL,
    ),
    messages: [{ role: "user", content: userPrompt }],
    systemPrompts: [SYSTEM_PROMPT],
    temperature: 0.7,
  });

  return streamToTextResponse(stream);
}
