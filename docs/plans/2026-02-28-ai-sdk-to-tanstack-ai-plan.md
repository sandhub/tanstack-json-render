# AI SDK to TanStack AI Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Vercel AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/gateway`) with TanStack AI (`@tanstack/ai`, `@tanstack/ai-react`, `@tanstack/ai-anthropic`, `@tanstack/ai-openrouter`) across the entire codebase.

**Architecture:** Bottom-up migration: core streaming types → server-side tools → server-side routes → client-side components → tests → docs. Two streaming patterns: (1) simple generate routes return plain text (unchanged client), (2) chat routes use TanStack AI SSE with spec handling via `onChunk`.

**Tech Stack:** TanStack AI (alpha), @tanstack/ai-react, @tanstack/ai-anthropic, @tanstack/ai-openrouter, zod, React 19

**Design doc:** `docs/plans/2026-02-28-ai-sdk-to-tanstack-ai-migration-design.md`

---

### Task 1: Install TanStack AI Packages

**Files:**
- Modify: `examples/chat/package.json`
- Modify: `apps/web/package.json`
- Modify: `examples/dashboard/package.json`
- Modify: `examples/react-pdf/package.json`
- Modify: `examples/react-native/package.json`
- Modify: `examples/remotion/package.json`
- Modify: `examples/image/package.json`
- Modify: `examples/stripe-app/api/package.json`
- Modify: `tests/e2e/package.json` (if separate)

**Step 1: Add TanStack AI packages to examples/chat**

In `examples/chat/`, remove `ai`, `@ai-sdk/react`, `@ai-sdk/gateway` and add `@tanstack/ai`, `@tanstack/ai-react`, `@tanstack/ai-anthropic`, `@tanstack/ai-openrouter`:

```bash
cd examples/chat && pnpm remove ai @ai-sdk/react @ai-sdk/gateway && pnpm add @tanstack/ai @tanstack/ai-react @tanstack/ai-anthropic @tanstack/ai-openrouter
```

**Step 2: Add TanStack AI packages to apps/web**

```bash
cd apps/web && pnpm remove ai @ai-sdk/react @ai-sdk/gateway && pnpm add @tanstack/ai @tanstack/ai-react @tanstack/ai-anthropic
```

**Step 3: Update simple example packages**

For each of: `examples/dashboard`, `examples/react-pdf`, `examples/remotion`, `examples/image`, `examples/stripe-app/api`:

```bash
cd <example> && pnpm remove ai @ai-sdk/gateway && pnpm add @tanstack/ai @tanstack/ai-anthropic
```

For `examples/react-native`:
```bash
cd examples/react-native && pnpm remove ai @ai-sdk/gateway && pnpm add @tanstack/ai @tanstack/ai-anthropic
```

**Step 4: Update test dependencies**

Check `tests/e2e/package.json` — if `ai` is listed, replace:
```bash
cd tests/e2e && pnpm remove ai && pnpm add @tanstack/ai @tanstack/ai-anthropic
```

If tests use root workspace deps, update root `package.json` instead.

**Step 5: Verify install**

```bash
pnpm install && pnpm type-check
```

Expected: type errors since code still imports from `ai` — that's fine, we're changing the code next.

**Step 6: Commit**

```bash
git add -A && git commit -m "chore: swap ai-sdk packages for tanstack-ai"
```

---

### Task 2: Core Package — StreamChunk Type & Helpers

**Files:**
- Modify: `packages/core/src/types.ts:998-1305`

**Step 1: Update StreamChunk type**

Replace lines 992-1002 in `packages/core/src/types.ts`:

```typescript
/**
 * Minimal chunk shape compatible with TanStack AI's SSE StreamChunk.
 *
 * Defined here so that `@json-render/core` has no dependency on the
 * `@tanstack/ai` package. The discriminated union covers the text-related
 * chunk types the transform inspects; all other chunk types pass through.
 */
export type StreamChunk =
  | { type: "content"; id: string; delta: string; content: string; [k: string]: unknown }
  | { type: "tool_call"; id: string; toolCall: unknown; [k: string]: unknown }
  | { type: "tool_result"; id: string; toolCallId: string; content: string; [k: string]: unknown }
  | { type: "done"; id: string; finishReason: string; [k: string]: unknown }
  | { type: "spec"; data: SpecDataPart; [k: string]: unknown }
  | { type: string; [k: string]: unknown };
```

**Step 2: Add streamToTextResponse helper**

Add this function after the `pipeJsonRender` function (after line ~1305):

```typescript
/**
 * Convert a TanStack AI chat stream to a plain-text Response.
 *
 * Extracts text deltas from `content` chunks and streams them as raw UTF-8.
 * Useful for "generate" endpoints that return JSONL text (not SSE), consumed
 * by `useUIStream` on the client.
 *
 * @example
 * ```ts
 * import { chat } from "@tanstack/ai";
 * import { streamToTextResponse } from "@json-render/core";
 *
 * const stream = chat({ adapter, messages, systemPrompts: [system] });
 * return streamToTextResponse(stream);
 * ```
 */
export function streamToTextResponse(
  stream: AsyncIterable<StreamChunk>,
  headers?: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (chunk.type === "content" && "delta" in chunk) {
            controller.enqueue(encoder.encode(chunk.delta as string));
          }
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}
```

**Step 3: Rewrite createJsonRenderTransform as async generator**

Replace the existing `createJsonRenderTransform` function (lines 1039-1245) and `pipeJsonRender` (lines 1299-1305) with:

```typescript
/**
 * Async generator that intercepts a TanStack AI chat stream and classifies
 * text content as either prose or json-render JSONL patches.
 *
 * Two classification modes:
 *
 * 1. **Fence mode** (preferred): Lines between ` ```spec ` and ` ``` ` are
 *    parsed as JSONL patches. Fence delimiters are swallowed (not emitted).
 * 2. **Heuristic mode** (backward compat): Outside of fences, lines starting
 *    with `{` are tested with `parseSpecStreamLine`. Valid patches are
 *    emitted as `spec` chunks; everything else is emitted as `content`.
 *
 * Non-content chunks (tool events, done markers, etc.) pass through unchanged.
 *
 * @example
 * ```ts
 * import { chat, toServerSentEventsResponse } from "@tanstack/ai";
 * import { pipeJsonRender } from "@json-render/core";
 *
 * const raw = chat({ adapter, messages, tools, systemPrompts: [instructions] });
 * return toServerSentEventsResponse(pipeJsonRender(raw));
 * ```
 */
export async function* pipeJsonRender(
  source: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  let lineBuffer = "";
  let inSpecFence = false;

  function* processCompleteLine(
    line: string,
    chunk: StreamChunk,
  ): Generator<StreamChunk> {
    const trimmed = line.trim();

    // --- Fence detection ---
    if (!inSpecFence && trimmed.startsWith(SPEC_FENCE_OPEN)) {
      inSpecFence = true;
      return;
    }
    if (inSpecFence && trimmed === SPEC_FENCE_CLOSE) {
      inSpecFence = false;
      return;
    }

    if (inSpecFence) {
      if (trimmed) {
        const patch = parseSpecStreamLine(trimmed);
        if (patch) {
          yield { type: "spec", data: { type: "patch", patch } as SpecDataPart };
        }
      }
      return;
    }

    // --- Outside fence: heuristic mode ---
    if (!trimmed) {
      yield { ...chunk, type: "content", delta: "\n", content: "\n" };
      return;
    }

    const patch = parseSpecStreamLine(trimmed);
    if (patch) {
      yield { type: "spec", data: { type: "patch", patch } as SpecDataPart };
    } else {
      yield { ...chunk, type: "content", delta: line + "\n", content: line + "\n" };
    }
  }

  for await (const chunk of source) {
    if (chunk.type !== "content") {
      // Non-content chunks pass through
      yield chunk;
      continue;
    }

    const delta = (chunk as { delta: string }).delta;

    for (let i = 0; i < delta.length; i++) {
      const ch = delta.charAt(i);

      if (ch === "\n") {
        // Line complete — classify and emit
        yield* processCompleteLine(lineBuffer, chunk);
        lineBuffer = "";
      } else {
        lineBuffer += ch;
      }
    }
  }

  // Flush remaining buffer
  if (lineBuffer.trim()) {
    const trimmed = lineBuffer.trim();
    if (inSpecFence) {
      const patch = parseSpecStreamLine(trimmed);
      if (patch) {
        yield { type: "spec", data: { type: "patch", patch } as SpecDataPart };
      }
    } else {
      const patch = parseSpecStreamLine(trimmed);
      if (patch) {
        yield { type: "spec", data: { type: "patch", patch } as SpecDataPart };
      } else if (lineBuffer) {
        yield { type: "content", id: "", delta: lineBuffer, content: lineBuffer };
      }
    }
  }
}

/**
 * Legacy TransformStream version of the json-render transform.
 * Operates on the new TanStack AI StreamChunk format.
 *
 * Prefer `pipeJsonRender()` (async generator) for TanStack AI integration.
 * This TransformStream version is kept for compatibility with web streams APIs.
 */
export function createJsonRenderTransform(): TransformStream<
  StreamChunk,
  StreamChunk
> {
  let lineBuffer = "";
  let inSpecFence = false;

  function emitPatch(
    patch: SpecStreamLine,
    controller: TransformStreamDefaultController<StreamChunk>,
  ) {
    controller.enqueue({
      type: "spec",
      data: { type: "patch", patch } as SpecDataPart,
    });
  }

  function processCompleteLine(
    line: string,
    chunk: StreamChunk,
    controller: TransformStreamDefaultController<StreamChunk>,
  ) {
    const trimmed = line.trim();

    if (!inSpecFence && trimmed.startsWith(SPEC_FENCE_OPEN)) {
      inSpecFence = true;
      return;
    }
    if (inSpecFence && trimmed === SPEC_FENCE_CLOSE) {
      inSpecFence = false;
      return;
    }

    if (inSpecFence) {
      if (trimmed) {
        const patch = parseSpecStreamLine(trimmed);
        if (patch) emitPatch(patch, controller);
      }
      return;
    }

    if (!trimmed) {
      controller.enqueue({ ...chunk, type: "content", delta: "\n", content: "\n" } as StreamChunk);
      return;
    }

    const patch = parseSpecStreamLine(trimmed);
    if (patch) {
      emitPatch(patch, controller);
    } else {
      controller.enqueue({ ...chunk, type: "content", delta: line + "\n", content: line + "\n" } as StreamChunk);
    }
  }

  return new TransformStream<StreamChunk, StreamChunk>({
    transform(chunk, controller) {
      if (chunk.type !== "content") {
        controller.enqueue(chunk);
        return;
      }

      const delta = (chunk as { delta: string }).delta;

      for (let i = 0; i < delta.length; i++) {
        const ch = delta.charAt(i);
        if (ch === "\n") {
          processCompleteLine(lineBuffer, chunk, controller);
          lineBuffer = "";
        } else {
          lineBuffer += ch;
        }
      }
    },

    flush(controller) {
      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        const patch = parseSpecStreamLine(trimmed);
        if (patch) {
          emitPatch(patch, controller);
        } else if (!inSpecFence && lineBuffer) {
          controller.enqueue({ type: "content", id: "", delta: lineBuffer, content: lineBuffer } as StreamChunk);
        }
      }
    },
  });
}
```

**Step 4: Update exports in types.ts**

Ensure `streamToTextResponse` is exported. Check the barrel export in `packages/core/src/index.ts`:

```typescript
export { streamToTextResponse } from "./types";
```

**Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat(core): update StreamChunk for TanStack AI, add streamToTextResponse"
```

---

### Task 3: Core Package — Update Tests

**Files:**
- Modify: `packages/core/src/types.test.ts:879-1123`

**Step 1: Update the test helper to use TanStack AI chunk format**

The test helper `transformText()` currently sends `text-start`, `text-delta`, `text-end` chunks. Update it to send `content` chunks (TanStack AI format):

Replace the `transformText` helper and all tests in the `createJsonRenderTransform` describe block (lines 882-1123) with:

```typescript
describe("createJsonRenderTransform", () => {
  /** Helper: push content chunks through the transform and collect output */
  async function transformText(text: string): Promise<StreamChunk[]> {
    const transform = createJsonRenderTransform();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const chunks: StreamChunk[] = [];

    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();

    // Send as a single content chunk (TanStack AI format)
    await writer.write({
      type: "content",
      id: "msg_1",
      delta: text,
      content: text,
    } as StreamChunk);
    await writer.close();

    await readAll;
    return chunks;
  }

  it("passes prose text through as content chunks", async () => {
    const chunks = await transformText("Hello world\n");
    const contentChunks = chunks.filter((c) => c.type === "content");
    const text = contentChunks
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain("Hello world");
  });

  it("classifies valid JSONL patches as spec chunks (heuristic mode)", async () => {
    const patch = '{"op":"add","path":"/root","value":"main"}\n';
    const chunks = await transformText(patch);
    const specChunks = chunks.filter((c) => c.type === "spec");
    expect(specChunks.length).toBe(1);
    expect(
      (specChunks[0] as { data: { type: string } }).data.type,
    ).toBe("patch");
  });

  it("lines starting with { that are NOT patches are flushed as content", async () => {
    const line = '{"not":"a patch"}\n';
    const chunks = await transformText(line);
    const specChunks = chunks.filter((c) => c.type === "spec");
    const contentChunks = chunks.filter((c) => c.type === "content");
    expect(specChunks.length).toBe(0);
    const text = contentChunks
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain('{"not":"a patch"}');
  });

  it("parses content inside ```spec fence as patches", async () => {
    const input = [
      "Here is some UI:\n",
      "```spec\n",
      '{"op":"add","path":"/root","value":"main"}\n',
      '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{},"children":[]}}\n',
      "```\n",
      "Done!\n",
    ].join("");

    const chunks = await transformText(input);
    const specChunks = chunks.filter((c) => c.type === "spec");
    expect(specChunks.length).toBe(2);

    const contentChunks = chunks.filter((c) => c.type === "content");
    const text = contentChunks
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain("Here is some UI:");
    expect(text).toContain("Done!");
    expect(text).not.toContain("```spec");
  });

  it("handles mixed text + heuristic patches in single stream", async () => {
    const input = [
      "Some text\n",
      '{"op":"add","path":"/root","value":"r"}\n',
      "More text\n",
    ].join("");

    const chunks = await transformText(input);
    const specChunks = chunks.filter((c) => c.type === "spec");
    expect(specChunks.length).toBe(1);

    const contentChunks = chunks.filter((c) => c.type === "content");
    const text = contentChunks
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain("Some text");
    expect(text).toContain("More text");
  });

  it("non-content chunks pass through unchanged", async () => {
    const transform = createJsonRenderTransform();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const toolChunk = {
      type: "tool_call",
      id: "msg_1",
      toolCall: { id: "call_abc", type: "function", function: { name: "test", arguments: "{}" } },
    };

    const readPromise = reader.read();
    await writer.write(toolChunk as StreamChunk);
    await writer.close();

    const { value } = await readPromise;
    expect(value).toEqual(toolChunk);
  });

  it("flush behavior: buffered patch at end of stream", async () => {
    const transform = createJsonRenderTransform();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const chunks: StreamChunk[] = [];
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();

    // Content with no trailing newline
    await writer.write({
      type: "content",
      id: "msg_1",
      delta: '{"op":"add","path":"/root","value":"main"}',
      content: '{"op":"add","path":"/root","value":"main"}',
    } as StreamChunk);
    await writer.close();

    await readAll;

    const specChunks = chunks.filter((c) => c.type === "spec");
    expect(specChunks.length).toBe(1);
  });

  it("consecutive patches produce spec chunks without content between them", async () => {
    const input = [
      '{"op":"add","path":"/root","value":"r"}\n',
      '{"op":"add","path":"/elements/r","value":{"type":"Card","props":{},"children":[]}}\n',
    ].join("");

    const chunks = await transformText(input);

    const specChunks = chunks.filter((c) => c.type === "spec");
    expect(specChunks.length).toBe(2);

    const contentChunks = chunks.filter((c) => c.type === "content");
    const textContent = contentChunks
      .map((c) => (c as { delta: string }).delta)
      .join("")
      .trim();
    expect(textContent).toBe("");
  });
});
```

**Step 2: Run tests to verify they pass**

```bash
cd packages/core && pnpm test -- --run
```

Expected: All tests pass with the new chunk format.

**Step 3: Commit**

```bash
git add packages/core/src/types.test.ts
git commit -m "test(core): update createJsonRenderTransform tests for TanStack AI chunk format"
```

---

### Task 4: Migrate Chat Tool Definitions

**Files:**
- Modify: `examples/chat/lib/tools/weather.ts`
- Modify: `examples/chat/lib/tools/github.ts`
- Modify: `examples/chat/lib/tools/crypto.ts`
- Modify: `examples/chat/lib/tools/hackernews.ts`
- Modify: `examples/chat/lib/tools/search.ts`

**Step 1: Migrate weather tool**

Replace `examples/chat/lib/tools/weather.ts` lines 1-16:

```typescript
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

/**
 * Get current weather and 7-day forecast for a city using Open-Meteo API.
 * Free, no API key required.
 * https://open-meteo.com/
 */
const getWeatherDef = toolDefinition({
  name: "getWeather",
  description:
    "Get current weather conditions and a 7-day forecast for a given city. Returns temperature, humidity, wind speed, weather conditions, and daily forecasts.",
  inputSchema: z.object({
    city: z
      .string()
      .describe("City name (e.g., 'New York', 'London', 'Tokyo')"),
  }),
});

export const getWeather = getWeatherDef.server(async ({ city }) => {
```

Keep the execute body identical (lines 18-95). Close with `});` instead of the current closing.

**Step 2: Migrate github tools**

Replace `examples/chat/lib/tools/github.ts` lines 1-2 with:

```typescript
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
```

Replace `getGitHubRepo` definition (lines 25-98):

```typescript
const getGitHubRepoDef = toolDefinition({
  name: "getGitHubRepo",
  description:
    "Get information about a public GitHub repository including stars, forks, open issues, description, language, and recent activity.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (e.g., 'vercel')"),
    repo: z.string().describe("Repository name (e.g., 'next.js')"),
  }),
});

export const getGitHubRepo = getGitHubRepoDef.server(async ({ owner, repo }) => {
```

Keep execute body (lines 33-97). Same for `getGitHubPullRequests` (lines 131-237):

```typescript
const getGitHubPullRequestsDef = toolDefinition({
  name: "getGitHubPullRequests",
  description: "Get pull requests from a public GitHub repository...",
  inputSchema: z.object({ /* same schema */ }),
});

export const getGitHubPullRequests = getGitHubPullRequestsDef.server(async ({ owner, repo, state, sort, perPage }) => {
```

**Step 3: Migrate crypto, hackernews tools**

Same pattern for `crypto.ts` (getCryptoPrice, getCryptoPriceHistory) and `hackernews.ts` (getHackerNewsTop). Replace `import { tool } from "ai"` with `import { toolDefinition } from "@tanstack/ai"` and wrap each `tool({...})` with `toolDefinition({name, description, inputSchema}).server(async (input) => {...})`.

**Step 4: Migrate search tool**

`examples/chat/lib/tools/search.ts` — this one also uses `generateText` and `gateway`:

```typescript
import { toolDefinition } from "@tanstack/ai";
import { chat } from "@tanstack/ai";
import { openrouterText } from "@tanstack/ai-openrouter";
import { z } from "zod";

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
    const result = await chat({
      adapter: openrouterText("perplexity/sonar"),
      messages: [{ role: "user", content: query }],
    });
    // Collect text from stream
    let text = "";
    for await (const chunk of result) {
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
```

**Step 5: Commit**

```bash
git add examples/chat/lib/tools/
git commit -m "feat(chat): migrate tool definitions from ai-sdk to tanstack-ai"
```

---

### Task 5: Migrate Chat Agent & API Route

**Files:**
- Modify: `examples/chat/lib/agent.ts`
- Modify: `examples/chat/app/api/generate/route.ts`

**Step 1: Rewrite agent.ts**

Replace `examples/chat/lib/agent.ts` entirely. The `ToolLoopAgent` pattern becomes a factory function that calls `chat()`:

```typescript
import { chat, type StreamChunk } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { explorerCatalog } from "./render/catalog";
import { getWeather } from "./tools/weather";
import { getGitHubRepo, getGitHubPullRequests } from "./tools/github";
import { getCryptoPrice, getCryptoPriceHistory } from "./tools/crypto";
import { getHackerNewsTop } from "./tools/hackernews";
import { webSearch } from "./tools/search";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const AGENT_INSTRUCTIONS = `You are a knowledgeable assistant...`;
// (keep the entire AGENT_INSTRUCTIONS string as-is, it's the same content)

const tools = [
  getWeather,
  getGitHubRepo,
  getGitHubPullRequests,
  getCryptoPrice,
  getCryptoPriceHistory,
  getHackerNewsTop,
  webSearch,
];

export function createAgentStream(
  messages: Array<{ role: string; content: string }>,
): AsyncIterable<StreamChunk> {
  return chat({
    adapter: anthropicText(
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") || DEFAULT_MODEL,
    ),
    messages,
    systemPrompts: [AGENT_INSTRUCTIONS],
    tools,
    modelOptions: { temperature: 0.7 },
  });
}
```

**Step 2: Rewrite chat API route**

Replace `examples/chat/app/api/generate/route.ts`:

```typescript
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
```

**Step 3: Verify type check**

```bash
cd examples/chat && pnpm type-check
```

**Step 4: Commit**

```bash
git add examples/chat/lib/agent.ts examples/chat/app/api/generate/route.ts
git commit -m "feat(chat): migrate agent and API route to tanstack-ai"
```

---

### Task 6: Migrate Simple Generate Routes

All these routes follow the same pattern: `streamText()` → `chat()` + `streamToTextResponse()`. They return plain text (not SSE) consumed by `useUIStream` on the client.

**Files:**
- Modify: `examples/dashboard/app/api/generate/route.ts`
- Modify: `examples/remotion/app/api/generate/route.ts`
- Modify: `examples/react-pdf/app/api/generate/route.ts`
- Modify: `examples/image/app/api/generate/route.ts`
- Modify: `examples/stripe-app/api/app/api/generate/route.ts`
- Modify: `examples/react-native/app/api/generate+api.ts`
- Modify: `apps/web/app/api/generate/route.ts`

**Step 1: Migrate dashboard route**

Replace `examples/dashboard/app/api/generate/route.ts`:

```typescript
import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { buildUserPrompt, streamToTextResponse } from "@json-render/core";
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
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") || DEFAULT_MODEL,
    ),
    messages: [{ role: "user", content: userPrompt }],
    systemPrompts: [SYSTEM_PROMPT],
    modelOptions: { temperature: 0.7 },
  });

  return streamToTextResponse(stream);
}
```

**Step 2: Migrate remotion route**

Replace `examples/remotion/app/api/generate/route.ts`:

```typescript
import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { streamToTextResponse } from "@json-render/core";
import { getVideoPrompt } from "@/lib/catalog";

export const maxDuration = 30;

const SYSTEM_PROMPT = getVideoPrompt();
const MAX_PROMPT_LENGTH = 500;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const sanitizedPrompt = String(prompt || "").slice(0, MAX_PROMPT_LENGTH);

  const stream = chat({
    adapter: anthropicText(
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") || DEFAULT_MODEL,
    ),
    messages: [{ role: "user", content: sanitizedPrompt }],
    systemPrompts: [SYSTEM_PROMPT],
    modelOptions: { temperature: 0.7 },
  });

  return streamToTextResponse(stream);
}
```

**Step 3: Migrate react-pdf, image, stripe-app routes**

Same pattern. For stripe-app, preserve the CORS headers by passing them to `streamToTextResponse`:

```typescript
return streamToTextResponse(stream, CORS_HEADERS);
```

For react-pdf and image routes, same pattern as dashboard.

**Step 4: Migrate react-native route**

```typescript
import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { buildUserPrompt, streamToTextResponse } from "@json-render/core";
import { catalog, customRules } from "../../lib/render/catalog";

const SYSTEM_PROMPT = catalog.prompt({ customRules });
const MAX_PROMPT_LENGTH = 500;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  try {
    const { prompt, context } = await req.json();

    const userPrompt = buildUserPrompt({
      prompt,
      currentSpec: context?.previousSpec,
      state: context?.state,
      maxPromptLength: MAX_PROMPT_LENGTH,
    });

    const stream = chat({
      adapter: anthropicText(
        process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") || DEFAULT_MODEL,
      ),
      messages: [{ role: "user", content: userPrompt }],
      systemPrompts: [SYSTEM_PROMPT],
      modelOptions: { temperature: 0.7 },
    });

    return streamToTextResponse(stream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

**Step 5: Migrate apps/web/app/api/generate/route.ts**

This route has rate limiting and usage metadata. The usage metadata (token counts) was appended after the text stream. With TanStack AI, we can get this from the `done` chunk:

```typescript
import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import type { StreamChunk } from "@json-render/core";
import { headers } from "next/headers";
import { buildUserPrompt } from "@json-render/core";
import { minuteRateLimit, dailyRateLimit } from "@/lib/rate-limit";
import { playgroundCatalog } from "@/lib/render/catalog";

export const maxDuration = 30;

const SYSTEM_PROMPT = playgroundCatalog.prompt({
  customRules: [
    // ... same rules as before
  ],
});

const MAX_PROMPT_LENGTH = 500;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function POST(req: Request) {
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0] ?? "anonymous";

  const [minuteResult, dailyResult] = await Promise.all([
    minuteRateLimit.limit(ip),
    dailyRateLimit.limit(ip),
  ]);

  if (!minuteResult.success || !dailyResult.success) {
    const isMinuteLimit = !minuteResult.success;
    return new Response(
      JSON.stringify({
        error: "Rate limit exceeded",
        message: isMinuteLimit
          ? "Too many requests. Please wait a moment before trying again."
          : "Daily limit reached. Please try again tomorrow.",
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  const { prompt, context } = await req.json();

  const userPrompt = buildUserPrompt({
    prompt,
    currentSpec: context?.previousSpec,
    maxPromptLength: MAX_PROMPT_LENGTH,
  });

  const chatStream = chat({
    adapter: anthropicText(
      process.env.AI_GATEWAY_MODEL?.replace(/^anthropic\//, "") || DEFAULT_MODEL,
    ),
    messages: [{ role: "user", content: userPrompt }],
    systemPrompts: [SYSTEM_PROMPT],
    modelOptions: { temperature: 0.7 },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
      for await (const chunk of chatStream) {
        if (chunk.type === "content" && "delta" in chunk) {
          controller.enqueue(encoder.encode(chunk.delta as string));
        }
        if (chunk.type === "done" && "usage" in chunk) {
          usage = chunk.usage as typeof usage;
        }
      }
      if (usage) {
        const meta = JSON.stringify({
          __meta: "usage",
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        });
        controller.enqueue(encoder.encode(`\n${meta}\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

**Step 6: Commit**

```bash
git add examples/dashboard examples/remotion examples/react-pdf examples/image examples/stripe-app examples/react-native apps/web/app/api/generate
git commit -m "feat: migrate all simple generate routes to tanstack-ai"
```

---

### Task 7: Migrate Docs-Chat Route

**Files:**
- Modify: `apps/web/app/api/docs-chat/route.ts`

**Step 1: Rewrite docs-chat route**

This route uses `streamText` with tools and `convertToModelMessages`. With TanStack AI, `chat()` handles messages and tools natively:

```typescript
import { readFile } from "fs/promises";
import { join } from "path";
import { chat, toServerSentEventsResponse, toolDefinition } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { z } from "zod";
import { createBashTool } from "bash-tool";
import { headers } from "next/headers";
import { allDocsPages } from "@/lib/docs-navigation";
import { mdxToCleanMarkdown } from "@/lib/mdx-to-markdown";
import { minuteRateLimit, dailyRateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a helpful documentation assistant...`;
// (keep SYSTEM_PROMPT content as-is)

async function loadDocsFiles(): Promise<Record<string, string>> {
  // (keep loadDocsFiles as-is)
}

export async function POST(req: Request) {
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0] ?? "anonymous";

  const [minuteResult, dailyResult] = await Promise.all([
    minuteRateLimit.limit(ip),
    dailyRateLimit.limit(ip),
  ]);

  if (!minuteResult.success || !dailyResult.success) {
    // (keep rate limit response as-is)
  }

  const { messages } = await req.json();

  const docsFiles = await loadDocsFiles();
  const {
    tools: { bash, readFile: readFileTool },
  } = await createBashTool({ files: docsFiles });

  // Note: bash-tool returns ai-sdk tool definitions.
  // We need to wrap them as TanStack AI tools.
  // If bash-tool doesn't support TanStack AI natively, we create wrapper tools:
  const bashToolDef = toolDefinition({
    name: "bash",
    description: bash.description ?? "Execute a bash command",
    inputSchema: bash.inputSchema ?? z.object({ command: z.string() }),
  });
  const bashServerTool = bashToolDef.server(async (input) => {
    return await bash.execute(input, { toolCallId: "", messages: [] });
  });

  const readFileToolDef = toolDefinition({
    name: "readFile",
    description: readFileTool.description ?? "Read a file",
    inputSchema: readFileTool.inputSchema ?? z.object({ path: z.string() }),
  });
  const readFileServerTool = readFileToolDef.server(async (input) => {
    return await readFileTool.execute(input, { toolCallId: "", messages: [] });
  });

  const stream = chat({
    adapter: anthropicText(DEFAULT_MODEL),
    messages,
    systemPrompts: [SYSTEM_PROMPT],
    tools: [bashServerTool, readFileServerTool],
    modelOptions: { temperature: 0 },
  });

  return toServerSentEventsResponse(stream);
}
```

> **Note:** The `bash-tool` package may provide tools in ai-sdk format. If so, we need wrapper definitions. Check `bash-tool` API. If it natively supports TanStack AI format, use directly. The above shows the wrapper approach as a safe default.

**Step 2: Verify type check**

```bash
cd apps/web && pnpm type-check
```

**Step 3: Commit**

```bash
git add apps/web/app/api/docs-chat/route.ts
git commit -m "feat(web): migrate docs-chat route to tanstack-ai"
```

---

### Task 8: React Package — Update Hooks for TanStack AI Message Format

**Files:**
- Modify: `packages/react/src/hooks.ts:405-446`

**Step 1: Update DataPart to support both AI SDK and TanStack AI**

In `packages/react/src/hooks.ts`, update the `DataPart` interface (line ~405):

```typescript
/**
 * A single part from a message's parts array. This is a minimal
 * structural type so that library helpers do not depend on any specific AI SDK.
 *
 * Supports both AI SDK format (text in `text` field) and
 * TanStack AI format (text in `content` field).
 */
export interface DataPart {
  type: string;
  /** Text content (AI SDK format) */
  text?: string;
  /** Text content (TanStack AI format) */
  content?: string;
  /** Data payload (for custom data parts) */
  data?: unknown;
}
```

**Step 2: Update getTextFromParts to handle both formats**

Replace `getTextFromParts` (line ~422):

```typescript
export function getTextFromParts(parts: DataPart[]): string {
  return parts
    .filter(
      (p): p is DataPart & { text: string } | DataPart & { content: string } =>
        p.type === "text" &&
        (typeof p.text === "string" || typeof p.content === "string"),
    )
    .map((p) => ((p.text ?? p.content) || "").trim())
    .filter(Boolean)
    .join("\n\n");
}
```

**Step 3: Update useJsonRenderMessage to accept external spec**

Add an optional `externalSpec` parameter so callers using TanStack AI can pass spec data collected via `onChunk`:

```typescript
export function useJsonRenderMessage(
  parts: DataPart[],
  externalSpec?: Spec | null,
) {
  const prevPartsRef = useRef<DataPart[]>([]);
  const prevResultRef = useRef<{ spec: Spec | null; text: string }>({
    spec: null,
    text: "",
  });

  const partsChanged =
    parts !== prevPartsRef.current &&
    (parts.length !== prevPartsRef.current.length ||
      parts[parts.length - 1] !==
        prevPartsRef.current[prevPartsRef.current.length - 1]);

  if (partsChanged || prevPartsRef.current.length === 0) {
    prevPartsRef.current = parts;
    prevResultRef.current = {
      spec: externalSpec ?? buildSpecFromParts(parts),
      text: getTextFromParts(parts),
    };
  }

  // If externalSpec changes, update
  const spec = externalSpec ?? prevResultRef.current.spec;
  const text = prevResultRef.current.text;
  const hasSpec = spec !== null && Object.keys(spec?.elements || {}).length > 0;
  return { spec, text, hasSpec };
}
```

**Step 4: Run react package tests**

```bash
cd packages/react && pnpm test -- --run
```

**Step 5: Commit**

```bash
git add packages/react/src/hooks.ts
git commit -m "feat(react): support TanStack AI message format in hooks"
```

---

### Task 9: Migrate Chat Client Page

**Files:**
- Modify: `examples/chat/app/page.tsx`

**Step 1: Update imports**

Replace lines 1-11:

```typescript
"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useChat, fetchServerSentEvents } from "@tanstack/ai-react";
import {
  type Spec,
  type SpecDataPart,
  applySpecPatch,
} from "@json-render/core";
import { useJsonRenderMessage } from "@json-render/react";
import { ExplorerRenderer } from "@/lib/render/renderer";
```

Keep other imports (ThemeToggle, lucide, streamdown, etc.)

**Step 2: Update types and transport**

Replace lines 24-35:

```typescript
// =============================================================================
// Types
// =============================================================================

type MessagePart = {
  type: string;
  content?: string;
  text?: string;
  name?: string;
  id?: string;
  state?: string;
  toolCallId?: string;
  output?: unknown;
};

// =============================================================================
// Connection
// =============================================================================

const connection = fetchServerSentEvents("/api/generate");
```

**Step 3: Update ToolCallDisplay for TanStack AI tool states**

Replace the ToolCallDisplay component's state checks:

```typescript
function ToolCallDisplay({
  toolName,
  state,
  result,
}: {
  toolName: string;
  state: string;
  result: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLoading =
    state !== "complete" &&
    state !== "error";
  // ... rest stays the same
}
```

**Step 4: Update MessageBubble for TanStack AI parts**

In `MessageBubble`, update the parts iteration. TanStack AI uses:
- `part.type === "text"` with `part.content` (not `part.text`)
- `part.type === "tool-call"` with `part.name`, `part.state`
- `part.type === "tool-result"` with `part.state`, `part.output`

```typescript
for (const part of message.parts) {
  if (part.type === "text") {
    const textContent = (part as { content?: string; text?: string }).content
      ?? (part as { text?: string }).text ?? "";
    if (!textContent.trim()) continue;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") {
      last.text += textContent;
    } else {
      segments.push({ kind: "text", text: textContent });
    }
  } else if (part.type === "tool-call" || part.type === "tool-result") {
    const tp = part as {
      type: string;
      id?: string;
      toolCallId?: string;
      name?: string;
      state: string;
      output?: unknown;
    };
    const toolName = tp.name || tp.type;
    const toolCallId = tp.toolCallId || tp.id || "";
    const last = segments[segments.length - 1];
    if (last?.kind === "tools") {
      last.tools.push({
        toolCallId,
        toolName,
        state: tp.state,
        output: tp.output,
      });
    } else {
      segments.push({
        kind: "tools",
        tools: [{
          toolCallId,
          toolName,
          state: tp.state,
          output: tp.output,
        }],
      });
    }
  }
}
```

**Step 5: Update ChatPage to use TanStack AI's useChat with spec handling**

```typescript
export default function ChatPage() {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isStickToBottom = useRef(true);
  const isAutoScrolling = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Spec handling: accumulate patches from onChunk
  const currentSpecRef = useRef<Spec>({ root: "", elements: {} });
  const [currentSpec, setCurrentSpec] = useState<Spec | null>(null);

  const { messages, sendMessage, setMessages, isLoading, error } = useChat({
    connection,
    onChunk: (chunk: { type: string; data?: unknown }) => {
      if (chunk.type === "spec") {
        const payload = (chunk as { data: SpecDataPart }).data;
        if (payload.type === "patch") {
          applySpecPatch(currentSpecRef.current, payload.patch);
          setCurrentSpec({ ...currentSpecRef.current });
        }
      }
    },
    onFinish: () => {
      // Reset spec accumulator for next message
      currentSpecRef.current = { root: "", elements: {} };
    },
  });

  const isStreaming = isLoading;

  // ... (keep scroll logic, handleSubmit, handleKeyDown, handleClear)
  // Update handleSubmit to use sendMessage(text) instead of sendMessage({ text })
  const handleSubmit = useCallback(
    async (text?: string) => {
      const message = text || input;
      if (!message.trim() || isStreaming) return;
      setInput("");
      setCurrentSpec(null);
      await sendMessage(message.trim());
    },
    [input, isStreaming, sendMessage],
  );

  // ... (rest of the component, using isStreaming instead of status checks)
```

In the `MessageBubble`, use `useJsonRenderMessage(message.parts, isLast ? currentSpec : null)`:

```typescript
function MessageBubble({
  message,
  isLast,
  isStreaming,
  currentSpec,
}: {
  message: typeof messages[number];
  isLast: boolean;
  isStreaming: boolean;
  currentSpec: Spec | null;
}) {
  const isUser = message.role === "user";
  const { spec, text, hasSpec } = useJsonRenderMessage(
    message.parts,
    isLast ? currentSpec : null,
  );
  // ... rest of rendering logic
```

**Step 6: Commit**

```bash
git add examples/chat/app/page.tsx
git commit -m "feat(chat): migrate client page to tanstack-ai useChat"
```

---

### Task 10: Migrate Docs-Chat Client Component

**Files:**
- Modify: `apps/web/components/docs-chat.tsx`

**Step 1: Update imports**

Replace lines 10-11:

```typescript
import { useChat, fetchServerSentEvents } from "@tanstack/ai-react";
```

Remove `DefaultChatTransport` import.

**Step 2: Update transport**

Replace line 17:

```typescript
const connection = fetchServerSentEvents("/api/docs-chat");
```

**Step 3: Update useChat usage**

Replace lines 147-151:

```typescript
  const { messages, sendMessage, isLoading: loadingState, setMessages, error } = useChat({
    connection,
  });

  const isLoading = loadingState;
```

Remove the old `const isLoading = status === "streaming" || status === "submitted";`.

**Step 4: Update message part access**

TanStack AI text parts use `.content` instead of `.text`. Update `hasVisibleContent` (line 321-327):

```typescript
  const hasVisibleContent = (
    parts: (typeof messages)[number]["parts"],
  ): boolean => {
    return parts.some(
      (p) =>
        (p.type === "text" && ((p as { content?: string }).content?.length ?? 0) > 0) ||
        isToolPart(p),
    );
  };
```

Update text rendering (lines 379-385):

```typescript
{message.parts
  .filter((p) => p.type === "text")
  .map((p) => (p as { content?: string; text?: string }).content ?? (p as { text?: string }).text ?? "")
  .join("")}
```

And assistant text rendering (line 390):

```typescript
if (part.type === "text" && ((part as { content?: string }).content || (part as { text?: string }).text)) {
  return (
    <div key={i} className="...">
      <Streamdown>{(part as { content?: string }).content ?? (part as { text?: string }).text ?? ""}</Streamdown>
    </div>
  );
}
```

Update tool part state checks — replace `"output-available"` with `"complete"` and `"output-error"` with `"error"`:

```typescript
const isDone = part.state === "complete";
const isError = part.state === "error";
```

**Step 5: Update sendMessage calls**

Replace `sendMessage({ text: input })` (line 310) and `sendMessage({ text: s })` (line 435) with:

```typescript
sendMessage(input);
// and
sendMessage(s);
```

**Step 6: Commit**

```bash
git add apps/web/components/docs-chat.tsx
git commit -m "feat(web): migrate docs-chat component to tanstack-ai"
```

---

### Task 11: Migrate E2E Tests

**Files:**
- Modify: `tests/e2e/state-store-e2e.test.ts`

**Step 1: Update imports and generateSpec function**

Replace lines 1-3:

```typescript
import { describe, it, expect } from "vitest";
import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { z } from "zod";
```

Replace `generateSpec` function (lines 61-81):

```typescript
async function generateSpec(): Promise<Spec> {
  const prompt = buildUserPrompt({
    prompt:
      "Create a simple form with two text inputs bound to state: one for /form/name and one for /form/email. Include initial state with name set to 'Alice' and email set to 'alice@example.com'. Use a vertical Stack as the container.",
  });

  const stream = chat({
    adapter: anthropicText("claude-haiku-4-5-20251001"),
    messages: [{ role: "user", content: prompt }],
    systemPrompts: [catalog.prompt()],
    modelOptions: { temperature: 0 },
  });

  const compiler = createSpecStreamCompiler<Spec>();

  for await (const chunk of stream) {
    if (chunk.type === "content" && "delta" in chunk) {
      compiler.push(chunk.delta as string);
    }
  }

  return compiler.getResult();
}
```

**Step 2: Run tests**

```bash
cd tests/e2e && pnpm test -- --run
```

Expected: Tests pass if `AI_GATEWAY_API_KEY` env var is set (tests are skipped otherwise).

**Step 3: Commit**

```bash
git add tests/e2e/state-store-e2e.test.ts
git commit -m "test(e2e): migrate state store tests to tanstack-ai"
```

---

### Task 12: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

**Step 1: Update AI SDK section**

Find the AI SDK / AI Gateway section (around lines 31-44) and replace with:

```markdown
### TanStack AI

- Use `@tanstack/ai` for server-side AI functions (`chat`, `toServerSentEventsResponse`, `toolDefinition`)
- Use `@tanstack/ai-react` for client-side hooks (`useChat`, `fetchServerSentEvents`)
- Use `@tanstack/ai-anthropic` with `anthropicText()` adapter for Anthropic models
- Use `@tanstack/ai-openrouter` with `openrouterText()` adapter for multi-provider routing
- Default model: `claude-haiku-4-5-20251001` via `anthropicText()`
- Environment variables: `AI_GATEWAY_API_KEY` for Anthropic API key
- For simple generate endpoints, use `streamToTextResponse()` from `@json-render/core`
- For chat endpoints with tools, use `chat()` + `toServerSentEventsResponse()`
- Tool definitions use `toolDefinition({ name, description, inputSchema }).server(fn)`

Example:
\`\`\`ts
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

const stream = chat({
  adapter: anthropicText("claude-haiku-4-5-20251001"),
  messages,
  systemPrompts: ["You are a helpful assistant"],
  modelOptions: { temperature: 0.7 },
});
return toServerSentEventsResponse(stream);
\`\`\`
```

**Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md for tanstack-ai"
```

---

### Task 13: Update Documentation Pages

**Files:**
- Modify: `apps/web/app/(main)/docs/ai-sdk/page.mdx`
- Modify: `apps/web/app/(main)/docs/streaming/page.mdx`
- Modify: `apps/web/app/(main)/docs/quick-start/page.mdx`
- Modify: `apps/web/app/(main)/docs/generation-modes/page.mdx`

**Step 1: Update ai-sdk page**

This is the main integration guide. Update all code examples:

- Replace `import { streamText } from "ai"` → `import { chat } from "@tanstack/ai"`
- Replace `import { gateway } from "@ai-sdk/gateway"` → `import { anthropicText } from "@tanstack/ai-anthropic"`
- Replace `streamText({ model, system, prompt })` → `chat({ adapter: anthropicText(model), messages: [...], systemPrompts: [system] })`
- Replace `result.toTextStreamResponse()` → `streamToTextResponse(stream)`
- Replace `import { useChat } from "@ai-sdk/react"` → `import { useChat, fetchServerSentEvents } from "@tanstack/ai-react"`
- Replace `DefaultChatTransport` → `fetchServerSentEvents`
- Update page title/description to reference TanStack AI instead of AI SDK

**Step 2: Update streaming page**

Update server-side examples to use TanStack AI.

**Step 3: Update quick-start page**

Update the API route step to use `chat()` instead of `streamText()`.

**Step 4: Update generation-modes page**

Update examples for both generate and chat modes.

**Step 5: Commit**

```bash
git add apps/web/app/\(main\)/docs/
git commit -m "docs: update all documentation for tanstack-ai migration"
```

---

### Task 14: Final Verification

**Step 1: Run full type check**

```bash
pnpm type-check
```

Fix any remaining type errors.

**Step 2: Run all tests**

```bash
pnpm test -- --run
```

**Step 3: Verify no remaining AI SDK imports**

```bash
grep -r "from \"ai\"" --include="*.ts" --include="*.tsx" -l
grep -r "@ai-sdk" --include="*.ts" --include="*.tsx" -l
```

Expected: No results (except possibly in docs/MDX files as code examples showing migration, and node_modules).

**Step 4: Clean up unused SPEC_DATA_PART_TYPE references**

If `SPEC_DATA_PART_TYPE` (`"data-spec"`) is no longer used for wire format, consider renaming or adding a note. The constant can stay for backward compat but the new wire type is `"spec"`.

**Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve remaining type errors from tanstack-ai migration"
```
