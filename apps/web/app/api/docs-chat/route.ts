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

const DEFAULT_MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a helpful documentation assistant for json-render, a library for AI-generated UI with guardrails.

GitHub repository: https://github.com/vercel-labs/json-render
Documentation: https://json-render.dev/docs
npm packages: @json-render/core, @json-render/react, @json-render/image, @json-render/remotion, @json-render/codegen

You have access to the full json-render documentation via the bash and readFile tools. The docs are available as markdown files in the /workspace/docs/ directory.

When answering questions:
- Use the bash tool to list files (ls /workspace/docs/) or search for content (grep -r "keyword" /workspace/docs/)
- Use the readFile tool to read specific documentation pages (e.g. readFile with path "/workspace/docs/index.md")
- Do NOT use bash to write, create, modify, or delete files (no tee, cat >, sed -i, echo >, cp, mv, rm, mkdir, touch, etc.) — you are read-only
- Always base your answers on the actual documentation content
- Be concise and accurate
- If the docs don't cover a topic, say so honestly
- Do NOT include source references or file paths in your response
- Do NOT use emojis in your responses`;

async function loadDocsFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  const results = await Promise.allSettled(
    allDocsPages.map(async (page) => {
      const slug =
        page.href === "/docs" ? "" : page.href.replace(/^\/docs\/?/, "");
      const filePath = slug
        ? join(
            process.cwd(),
            "app",
            "(main)",
            "docs",
            ...slug.split("/"),
            "page.mdx",
          )
        : join(process.cwd(), "app", "(main)", "docs", "page.mdx");

      const raw = await readFile(filePath, "utf-8");
      const md = mdxToCleanMarkdown(raw);
      const fileName = slug ? `/docs/${slug}.md` : "/docs/index.md";
      return { fileName, md };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      files[result.value.fileName] = result.value.md;
    }
  }

  return files;
}

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
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const { messages } = await req.json();

  const docsFiles = await loadDocsFiles();
  const {
    tools: { bash, readFile: readFileTool },
  } = await createBashTool({ files: docsFiles });

  // bash-tool returns ai-sdk tool definitions with inputSchema and execute.
  // We create wrapper TanStack AI tools:
  const bashToolDef = toolDefinition({
    name: "bash",
    description: bash.description ?? "Execute a bash command",
    inputSchema: bash.inputSchema ?? z.object({ command: z.string() }),
  });
  const bashServerTool = bashToolDef.server(async (input) => {
    return await bash.execute!(input as { command: string }, {
      toolCallId: "",
      messages: [],
    });
  });

  const readFileToolDef = toolDefinition({
    name: "readFile",
    description: readFileTool.description ?? "Read a file",
    inputSchema: readFileTool.inputSchema ?? z.object({ path: z.string() }),
  });
  const readFileServerTool = readFileToolDef.server(async (input) => {
    return await readFileTool.execute!(input as { path: string }, {
      toolCallId: "",
      messages: [],
    });
  });

  const stream = chat({
    adapter: anthropicText(DEFAULT_MODEL),
    messages,
    systemPrompts: [SYSTEM_PROMPT],
    tools: [bashServerTool, readFileServerTool],
    temperature: 0,
  });

  return toServerSentEventsResponse(stream);
}
