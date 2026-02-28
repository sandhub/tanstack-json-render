# AGENTS.md

Instructions for AI coding agents working with this codebase.

## Package Management

**Always check the latest version before installing a package.**

Before adding or updating any dependency, verify the current latest version on npm:

```bash
npm view <package-name> version
```

Or check multiple packages at once:

```bash
npm view @tanstack/ai version
npm view @tanstack/ai-anthropic version
npm view zod version
```

This ensures we don't install outdated versions that may have incompatible types or missing features.

## Code Style

- Do not use emojis in code or UI
- Use shadcn CLI to add shadcn/ui components: `pnpm dlx shadcn@latest add <component>`
- **Web app docs (`apps/web/`):** Never use Markdown table syntax (`| col | col |`). Always use HTML `<table>` with `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>`. Markdown tables do not render correctly in the web app. Inside HTML table cells, curly braces must be escaped as JSX expressions (e.g. `<code>{'{ "$state": "/path" }'}</code>`) because MDX parses `{` as a JSX expression boundary.

## TanStack AI

- Use `@tanstack/ai` for server-side AI functions (`chat`, `toServerSentEventsResponse`, `toolDefinition`)
- Use `@tanstack/ai-react` for client-side hooks (`useChat`, `fetchServerSentEvents`)
- Use `@tanstack/ai-anthropic` with `anthropicText()` adapter for Anthropic models
- Use `@tanstack/ai-openrouter` with `openRouterText()` adapter for multi-provider routing
- Default model: `claude-haiku-4-5-20251001` via `anthropicText()`
- Environment variables: `ANTHROPIC_API_KEY` for Anthropic API key
- For simple generate endpoints, use `streamToTextResponse()` from `@tanstack-json-render/core`
- For chat endpoints with tools, use `chat()` + `toServerSentEventsResponse()`
- Tool definitions use `toolDefinition({ name, description, inputSchema }).server(fn)`

Example:
```ts
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

const stream = chat({
  adapter: anthropicText("claude-haiku-4-5-20251001"),
  messages,
  systemPrompts: ["You are a helpful assistant"],
  temperature: 0.7,
});
return toServerSentEventsResponse(stream);
```

## Dev Servers

All apps and examples with dev servers use [portless](https://github.com/vercel-labs/portless) to avoid hardcoded ports. Portless assigns random ports and exposes each app via `.localhost` URLs.

Naming convention:
- Main web app: `json-render` → `json-render.localhost:1355`
- Examples: `[name]-demo.json-render` → `[name]-demo.json-render.localhost:1355`

When adding a new example that runs a dev server, wrap its `dev` script with `portless <name>`:

```json
{
  "scripts": {
    "dev": "portless my-example-demo.json-render next dev --turbopack"
  }
}
```

Do **not** add `--port` flags -- portless handles port assignment automatically. Do **not** add portless as a project dependency; it must be installed globally.

## Workflow

- Run `pnpm type-check` after each turn to ensure type safety
- When making user-facing changes (new packages, API changes, new features, renamed exports, changed behavior), update the relevant documentation:
  - Package `README.md` files in `packages/*/README.md`
  - Root `README.md` (if packages table, install commands, or examples are affected)
  - Web app docs in `apps/web/` (if guides, API references, or examples need updating)
  - Skills in `skills/*/SKILL.md` (if the package has a corresponding skill)
  - `AGENTS.md` (if workflow or conventions change)

## Releases

This monorepo uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.

### Fixed version group

All public `@tanstack-json-render/*` packages are in a **fixed** group (see `.changeset/config.json`). A changeset that bumps any one of them bumps all of them to the same version. You only need to list the packages that actually changed in the changeset front matter — the fixed group handles the rest.

### Preparing a release

When asked to prepare a release (e.g. "prepare v0.12.0"):

1. **Create a changeset file** at `.changeset/v0-<N>-release.md` following the existing pattern:
   - YAML front matter listing changed packages with bump type (`minor` for feature releases, `patch` for bug-fix-only releases)
   - A one-line summary, then `### New:` / `### Improved:` / `### Fixed:` sections describing each change
   - Always list `@tanstack-json-render/core` plus any packages with actual code changes
2. **Do NOT bump versions** in `package.json` files — CI runs `pnpm ci:version` (which calls `changeset version`) to do that automatically
3. **Do NOT manually write `CHANGELOG.md`** entries — `changeset version` generates them from the changeset file
4. **Add new packages to the fixed group** in `.changeset/config.json` if they should be versioned together with the rest
5. **Fill documentation gaps** — every public package should have:
   - A row in the root `README.md` packages table
   - A renderer section in the root `README.md` (if it's a renderer)
   - An API reference page at `apps/web/app/(main)/docs/api/<name>/page.mdx`
   - An entry in `apps/web/lib/page-titles.ts` and `apps/web/lib/docs-navigation.ts`
   - An entry in the docs-chat system prompt (`apps/web/app/api/docs-chat/route.ts`)
   - A skill at `skills/json-render-<name>/SKILL.md`
   - A `packages/<name>/README.md`
6. **Run `pnpm type-check`** after all changes to verify nothing is broken

### CI scripts

- `pnpm changeset` — interactively create a new changeset
- `pnpm ci:version` — run `changeset version` + lockfile update (CI only)
- `pnpm ci:publish` — build all packages and publish to npm (CI only)

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc tanstack/ai)
```

<!-- opensrc:end -->
