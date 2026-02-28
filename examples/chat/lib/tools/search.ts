import { toolDefinition, chat } from "@tanstack/ai";
import { openRouterText } from "@tanstack/ai-openrouter";
import { z } from "zod";

/**
 * Web search tool using Perplexity Sonar via OpenRouter.
 *
 * Perplexity Sonar models have built-in internet access and return
 * synthesized answers with citations. This is wrapped as a regular tool
 * (with a server function) so that ToolLoopAgent can loop: it calls
 * the model, gets results, and feeds them back for the next step.
 */
const webSearchDef = toolDefinition({
  name: "webSearch",
  description:
    "Search the web for current information on any topic. Use this when the user asks about something not covered by the specialized tools (weather, crypto, GitHub, Hacker News). Returns a synthesized answer based on real-time web data.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The search query — be specific and include relevant context for better results",
      ),
  }),
});

export const webSearch = webSearchDef.server(async ({ query }) => {
  try {
    const stream = chat({
      adapter: openRouterText("perplexity/sonar"),
      messages: [{ role: "user", content: query }],
    });
    // Collect text from stream
    let text = "";
    for await (const chunk of stream) {
      if (chunk.type === "content" && "delta" in chunk) {
        text += chunk.delta;
      }
    }
    return { content: text };
  } catch (error) {
    return {
      error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
});
