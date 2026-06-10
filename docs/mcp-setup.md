# MCP Server Setup

The `oss-dev` MCP server gives any AI agent read-only inspection of the platform's routes,
schemas, modules, events, and Drizzle tables - plus write tools to scaffold and verify. It
works with any MCP-compatible editor.

## Zero-config setup: `pnpm setup:mcp`

The fastest way to wire MCP for Claude Code. Run it right after `pnpm install`:

```bash
pnpm setup:mcp
```

It is idempotent and does three things against the current repo:

1. Ensures `.mcp.json` registers the MCP server (writes the `oss-dev` default if missing).
2. Adds every server name to `.claude/settings.json#enabledMcpjsonServers` so Claude Code
   trusts the server without a per-session prompt.
3. Installs the `/start` onboarding skill.

Then restart your editor (or run `/mcp`) and run **`/start`**: it asks what you want to build,
calls the `enhance-intent` tool to turn your fuzzy ask into a grounded spec (classified against
the decision tree, with live module/adapter/slot context), and drives the right scaffold flow.

A `create:app` consumer ships the same script (`pnpm setup:mcp`, delegating to this checkout) -
run it once in the generated repo so its own agents get the toolbelt.

## Server config snippet

The server uses stdio transport (no port). Add this to your editor's MCP config:

```json
{
  "mcpServers": {
    "oss-dev": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "tsx", "apps/mcp-server-dev/src/main.ts"]
    }
  }
}
```

## Per-editor setup

| Editor                       | Config location                                                                     | Notes                     |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| **Claude Code**              | `.mcp.json` at repo root (already present)                                          | Verify: `claude mcp list` |
| **Cursor**                   | Settings > MCP, or `.cursor/mcp.json` at repo root                                  | Paste the snippet above   |
| **Windsurf**                 | Cascade settings > MCP Servers                                                      | Paste the snippet above   |
| **VS Code + GitHub Copilot** | `.vscode/mcp.json` at repo root                                                     | Paste the snippet above   |
| **Any MCP client**           | `npx @modelcontextprotocol/inspector pnpm exec tsx apps/mcp-server-dev/src/main.ts` | Smoke-test in browser     |

## Available tools

### Read-only inspection (safe, no side effects)

| Tool                    | What it returns                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `read-agents-md`        | A named section from root or per-module AGENTS.md                                          |
| `list-modules`          | All registered modules + their group, tables, routes                                       |
| `describe-module`       | Full module surface: AGENTS.md + tables + schemas + routes in one call                     |
| `list-routes`           | oRPC route namespaces (filter by module name)                                              |
| `list-extension-points` | UI slots, exported events, adapter port interfaces                                         |
| `query-openapi`         | Search the generated OpenAPI spec by keyword                                               |
| `get-drizzle-schema`    | pgTable definitions across all modules (filter by module)                                  |
| `propose-table-change`  | Collision-check a new table name before adding it                                          |
| `schema-get`            | Find a Zod schema by name with its file location                                           |
| `docs-search`           | Full-text search across all docs/ and AGENTS.md files                                      |
| `db-query-readonly`     | Run a read-only SQL query against the dev database                                         |
| `list-slash-commands`   | List available slash commands (scaffold shortcuts)                                         |
| `enhance-intent`        | Turn a fuzzy "build X" ask into a classified, grounded brief + step-by-step playbook       |
| `start`                 | Onboarding entry point - call when user asks what to build; returns interactive Q&A script |
| `dev:infra`             | Start / stop / status local docker compose infra (postgres on :5432)                       |

### Write / scaffold (delegates to the same scripts humans use)

| Tool              | What it does                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `scaffold-module` | Creates a new module skeleton + registers it                                               |
| `scaffold-plugin` | Creates a new overlay extension skeleton                                                   |
| `scaffold-route`  | Adds an oRPC route stub to a module                                                        |
| `scaffold-app`    | Bootstraps a new downstream consumer repo (api + web + backoffice) linked to this checkout |
| `regen`           | Runs drizzle-kit generate + OpenAPI emit + catalog regeneration                            |
| `run-verify`      | Runs pnpm verify (typecheck + lint + tests)                                                |

## The consumer-facing server (`@oss/mcp`)

`oss-dev` (above) is the full toolkit for working _on_ this repo. There is a second,
read-only server - `@oss/mcp` (`packages/platform/mcp`) - that ships to downstream
consumers for inspecting the platform surface (catalog-overview, list-adapters, etc.).
It reads `docs/catalog.json`, resolving it by walking up from `cwd`, then falling back to
`node_modules/@oss/mcp/docs/catalog.json`.

Until it's published to npm, run it locally from the built `dist/`:

```bash
pnpm --filter @oss/mcp build   # rebuild after any source change
```

```json
{
  "mcpServers": {
    "oss": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/casino-oss/packages/platform/mcp/dist/main.js"]
    }
  }
}
```

Note: in a `create:app` consumer running in dev/link mode you don't need this - the
generated `.mcp.json` already points at the full `oss-dev` server through the sibling
checkout, which is a superset of `@oss/mcp`.

## Usage pattern for agents

```
1. read-agents-md  -> understand the decision tree
2. list-modules    -> see what already exists
3. describe-module -> deep-dive before editing a specific module
4. propose-table-change -> check for collisions before adding a table
5. scaffold-*      -> create the skeleton
6. run-verify      -> confirm nothing broke
```
