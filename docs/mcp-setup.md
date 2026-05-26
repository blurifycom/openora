# MCP Server Setup

The `oss-dev` MCP server gives any AI agent read-only inspection of the platform's routes,
schemas, modules, events, and Drizzle tables - plus write tools to scaffold and verify. It
works with any MCP-compatible editor.

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

| Editor | Config location | Notes |
|---|---|---|
| **Claude Code** | `.mcp.json` at repo root (already present) | Verify: `claude mcp list` |
| **Cursor** | Settings > MCP, or `.cursor/mcp.json` at repo root | Paste the snippet above |
| **Windsurf** | Cascade settings > MCP Servers | Paste the snippet above |
| **VS Code + GitHub Copilot** | `.vscode/mcp.json` at repo root | Paste the snippet above |
| **Any MCP client** | `npx @modelcontextprotocol/inspector pnpm exec tsx apps/mcp-server-dev/src/main.ts` | Smoke-test in browser |

## Available tools

### Read-only inspection (safe, no side effects)

| Tool | What it returns |
|---|---|
| `read-agents-md` | A named section from root or per-module AGENTS.md |
| `list-modules` | All registered modules + their group, tables, routes |
| `describe-module` | Full module surface: AGENTS.md + tables + schemas + routes in one call |
| `list-routes` | oRPC route namespaces (filter by module name) |
| `list-extension-points` | UI slots, exported events, adapter port interfaces |
| `query-openapi` | Search the generated OpenAPI spec by keyword |
| `get-drizzle-schema` | pgTable definitions across all modules (filter by module) |
| `propose-table-change` | Collision-check a new table name before adding it |
| `schema-get` | Find a Zod schema by name with its file location |
| `docs-search` | Full-text search across all docs/ and AGENTS.md files |
| `db-query-readonly` | Run a read-only SQL query against the dev database |
| `list-slash-commands` | List available slash commands (scaffold shortcuts) |

### Write / scaffold (delegates to the same scripts humans use)

| Tool | What it does |
|---|---|
| `scaffold-module` | Creates a new module skeleton + registers it |
| `scaffold-plugin` | Creates a new overlay extension skeleton |
| `scaffold-route` | Adds an oRPC route stub to a module |
| `regen` | Runs drizzle-kit generate + OpenAPI emit + catalog regeneration |
| `run-verify` | Runs pnpm verify (typecheck + lint + tests) |

## Usage pattern for agents

```
1. read-agents-md  -> understand the decision tree
2. list-modules    -> see what already exists
3. describe-module -> deep-dive before editing a specific module
4. propose-table-change -> check for collisions before adding a table
5. scaffold-*      -> create the skeleton
6. run-verify      -> confirm nothing broke
```
