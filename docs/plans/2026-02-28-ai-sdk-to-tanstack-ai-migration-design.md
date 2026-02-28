# AI SDK to TanStack AI Migration Design

## Context

The tanstack-json-render codebase currently uses Vercel's AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/gateway`) across 18 functional files: 8 server-side API routes, 2 client-side components, 5 tool definitions, and 1 e2e test. This document describes the migration to TanStack AI (`@tanstack/ai`, `@tanstack/ai-react`, `@tanstack/ai-anthropic`, `@tanstack/ai-openrouter`).

## Decisions

- **Model routing**: Use direct provider adapters (`anthropicText`, `openrouterText`) instead of AI Gateway.
- **Stream integration**: Adapt `createJsonRenderTransform()` to TanStack AI's SSE chunk format.
- **Scope**: Full migration -- all examples, web app, core package, and e2e tests.
- **Perplexity tool**: Use `@tanstack/ai-openrouter` adapter for Perplexity Sonar access.
- **Spec data delivery**: Inject custom `spec` chunk type into the SSE stream; handle on client via custom connection adapter.
- **Approach**: Bottom-up (core first, then server routes, then client, then examples).

## Architecture

### Package Dependencies

Remove:
- `ai` (Vercel AI SDK)
- `@ai-sdk/react`
- `@ai-sdk/gateway`

Add:
- `@tanstack/ai` -- core server functions (`chat`, `toServerSentEventsResponse`, `toolDefinition`)
- `@tanstack/ai-react` -- React hooks (`useChat`, `fetchServerSentEvents`)
- `@tanstack/ai-anthropic` -- Anthropic adapter (`anthropicText`)
- `@tanstack/ai-openrouter` -- OpenRouter adapter (for Perplexity Sonar and multi-model routing)

### Layer 1: Core Package (`packages/core/src/types.ts`)

#### StreamChunk Type

Current AI SDK format:
```typescript
type StreamChunk =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: string; [k: string]: unknown };
```

New TanStack AI format:
```typescript
type StreamChunk =
  | { type: "content"; id: string; delta: string; content: string }
  | { type: "tool_call"; id: string; toolCall: { id: string; type: string; function: { name: string; arguments: string } } }
  | { type: "tool_result"; id: string; toolCallId: string; content: string }
  | { type: "done"; id: string; finishReason: string }
  | { type: "spec"; data: SpecDataPart }
  | { type: string; [k: string]: unknown };
```

#### createJsonRenderTransform()

Rewrite to handle TanStack AI's `content` chunks instead of `text-start`/`text-delta`/`text-end`. The core logic stays the same (detect spec fences, parse JSONL patches), but the chunk processing changes:

- `content` chunks: Extract `delta` field, buffer and classify as text or spec patch.
- When a spec patch is detected, emit a custom `{ type: "spec", data: { type: "patch", patch } }` chunk.
- When text is detected, emit a modified `content` chunk with only the text portion.
- `tool_call`, `tool_result`, `done`, and other chunks pass through unchanged.

The text-start/text-end bookkeeping is eliminated since TanStack AI uses simpler content chunks.

#### pipeJsonRender()

Stays as a convenience wrapper. Updated to work with the new transform.

#### SPEC_DATA_PART / SPEC_DATA_PART_TYPE

These constants and the `SpecDataPart` type remain for use in the client-side message processing. The wire format changes from AI SDK's `data-spec` to our custom `spec` chunk type.

### Layer 2: Server-Side API Routes

#### Simple Streaming Routes

Pattern: `streamText()` + `toTextStreamResponse()` -> `chat()` + `toServerSentEventsResponse()`

Affected files:
- `apps/web/app/api/generate/route.ts`
- `examples/react-pdf/app/api/generate/route.ts`
- `examples/react-native/app/api/generate+api.ts`
- `examples/remotion/app/api/generate/route.ts`
- `examples/image/app/api/generate/route.ts`
- `examples/stripe-app/api/app/api/generate/route.ts`
- `examples/dashboard/app/api/generate/route.ts` (if exists)

```typescript
// Before
import { streamText } from "ai";
import { gateway } from "@ai-sdk/gateway";
const result = streamText({ model: gateway(modelId), system, prompt });
return result.toTextStreamResponse();

// After
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
const stream = chat({ adapter: anthropicText(modelId), messages: [{ role: "system", content: system }, { role: "user", content: prompt }] });
return toServerSentEventsResponse(stream);
```

#### Agent/Tool Loop Routes

Pattern: `ToolLoopAgent` + `stepCountIs()` -> `chat()` with `tools`

Affected files:
- `examples/chat/lib/agent.ts`
- `examples/chat/app/api/generate/route.ts`
- `apps/web/app/api/docs-chat/route.ts`

TanStack AI's `chat()` handles tool loops natively -- it calls tools, feeds results back, and continues until the model stops requesting tools.

```typescript
// Before
const agent = new ToolLoopAgent({ model: gateway(modelId), instructions, tools, stopWhen: stepCountIs(5) });
const result = await agent.stream({ messages });

// After
const stream = chat({
  adapter: anthropicText(modelId),
  messages,
  systemPrompts: [instructions],
  tools: [tool1, tool2, ...],
});
```

#### Tool Definitions

Pattern: `tool({ inputSchema, execute })` -> `toolDefinition({ inputSchema }).server(execute)`

Affected files:
- `examples/chat/lib/tools/weather.ts`
- `examples/chat/lib/tools/github.ts`
- `examples/chat/lib/tools/crypto.ts`
- `examples/chat/lib/tools/hackernews.ts`
- `examples/chat/lib/tools/search.ts`

```typescript
// Before
import { tool } from "ai";
export const getWeather = tool({ description, inputSchema, execute: async (input) => {...} });

// After
import { toolDefinition } from "@tanstack/ai";
const getWeatherDef = toolDefinition({ name: "getWeather", description, inputSchema });
export const getWeather = getWeatherDef.server(async (input) => {...});
```

#### Chat API Route (Spec Streaming)

The chat API route needs to pipe the `chat()` stream through the json-render transform before converting to SSE:

```typescript
// After
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { createJsonRenderTransform } from "@json-render/core";

const stream = chat({ adapter: anthropicText(modelId), messages, tools, systemPrompts: [instructions] });
// Pipe through json-render transform to extract spec patches
const transformed = stream.pipeThrough(createJsonRenderTransform());
return toServerSentEventsResponse(transformed);
```

### Layer 3: Client-Side Components

#### useChat Migration

Affected files:
- `examples/chat/app/page.tsx`
- `apps/web/components/docs-chat.tsx`

```typescript
// Before
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
const transport = new DefaultChatTransport({ api: "/api/generate" });
const { messages, sendMessage, setMessages, status, error } = useChat({ transport });
const isStreaming = status === "streaming" || status === "submitted";

// After
import { useChat, fetchServerSentEvents } from "@tanstack/ai-react";
const { messages, sendMessage, setMessages, isLoading, error, stop } = useChat({
  connection: fetchServerSentEvents("/api/generate"),
});
```

#### Message Parts

TanStack AI message parts differ from AI SDK:

| AI SDK | TanStack AI |
|--------|-------------|
| `part.type === "text"`, `part.text` | `part.type === "text"`, `part.content` |
| `part.type.startsWith("tool-")` | `part.type === "tool-call"` or `part.type === "tool-result"` |
| `part.type === SPEC_DATA_PART_TYPE` | Custom handling via connection adapter |
| `part.state === "output-available"` | `part.state === "complete"` |

#### Spec Data Handling on Client

Create a custom connection adapter that wraps `fetchServerSentEvents`, intercepts custom `spec` chunks, and stores them in a way that `useJsonRenderMessage` can access:

```typescript
function createSpecAwareConnection(url: string) {
  // Wrap fetchServerSentEvents to intercept spec chunks
  // Store spec patches in a shared state/context
  // Forward non-spec chunks to useChat normally
}
```

The `useJsonRenderMessage` hook in `@json-render/react` will need updating to read spec data from this new mechanism instead of looking for `SPEC_DATA_PART_TYPE` message parts.

### Layer 4: E2E Tests

File: `tests/e2e/state-store-e2e.test.ts`

Update to use `chat()` instead of `streamText()` and process the stream using `createSpecStreamCompiler`.

## Files Affected

### Core Package
- `packages/core/src/types.ts` -- StreamChunk type, createJsonRenderTransform(), pipeJsonRender()
- `packages/core/package.json` -- Remove `ai` peer dependency if present

### React Package
- `packages/react/` -- Update useJsonRenderMessage to handle new spec data mechanism

### Examples (chat)
- `examples/chat/lib/agent.ts` -- ToolLoopAgent -> chat()
- `examples/chat/app/api/generate/route.ts` -- API route migration
- `examples/chat/lib/tools/*.ts` -- All 5 tool files
- `examples/chat/app/page.tsx` -- useChat migration
- `examples/chat/package.json` -- Dependency swap

### Web App
- `apps/web/app/api/generate/route.ts`
- `apps/web/app/api/docs-chat/route.ts`
- `apps/web/components/docs-chat.tsx`
- `apps/web/package.json`

### Other Examples
- `examples/dashboard/` -- If has AI code
- `examples/react-pdf/app/api/generate/route.ts`
- `examples/react-native/app/api/generate+api.ts`
- `examples/remotion/app/api/generate/route.ts`
- `examples/image/app/api/generate/route.ts`
- `examples/stripe-app/api/app/api/generate/route.ts`
- All corresponding `package.json` files

### Tests
- `tests/e2e/state-store-e2e.test.ts`

### Documentation
- `apps/web/app/(main)/docs/ai-sdk/page.mdx` -- Update references
- `apps/web/app/(main)/docs/streaming/page.mdx` -- Update examples
- `apps/web/app/(main)/docs/quick-start/page.mdx` -- Update examples
- `AGENTS.md` -- Update AI SDK references

## Risk Mitigation

1. **TanStack AI is alpha**: Pin exact versions in package.json. Document which version was tested.
2. **Stream format differences**: Comprehensive testing of the spec streaming pipeline with the new chunk format.
3. **Missing features**: If TanStack AI lacks something needed, create minimal shims rather than keeping AI SDK as a dependency.
4. **Breaking changes**: Since this is a library consumed by users, update all documentation and examples simultaneously.
