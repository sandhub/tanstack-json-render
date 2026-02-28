import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import {
  buildUserPrompt,
  streamToTextResponse,
} from "@tanstack-json-render/core";
import { catalog, customRules } from "../../lib/render/catalog";

const SYSTEM_PROMPT = catalog.prompt({ customRules });

const MAX_PROMPT_LENGTH = 500;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  console.log("[API] POST /api/generate called");
  console.log("[API] API key present:", !!process.env.ANTHROPIC_API_KEY);
  console.log("[API] Model:", process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL);

  try {
    const { prompt, context } = await req.json();
    console.log("[API] prompt:", prompt);

    const userPrompt = buildUserPrompt({
      prompt,
      currentSpec: context?.previousSpec,
      state: context?.state,
      maxPromptLength: MAX_PROMPT_LENGTH,
    });

    console.log(
      "[API] calling chat with model:",
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") ||
        DEFAULT_MODEL,
    );
    const stream = chat({
      adapter: anthropicText(
        process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") ||
          DEFAULT_MODEL,
      ),
      messages: [{ role: "user", content: userPrompt }],
      systemPrompts: [SYSTEM_PROMPT],
      temperature: 0.7,
    });

    console.log("[API] returning text stream response");
    return streamToTextResponse(stream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("API generate error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
