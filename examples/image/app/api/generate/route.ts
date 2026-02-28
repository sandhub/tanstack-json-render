import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import {
  buildUserPrompt,
  streamToTextResponse,
  type Spec,
} from "@json-render/core";
import { imageCatalog } from "@/lib/catalog";

export const maxDuration = 60;

const SYSTEM_PROMPT = imageCatalog.prompt();

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  const { prompt, startingSpec } = (await req.json()) as {
    prompt: string;
    startingSpec?: Spec | null;
  };

  if (!prompt || typeof prompt !== "string") {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  const userPrompt = buildUserPrompt({
    prompt,
    currentSpec: startingSpec,
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
