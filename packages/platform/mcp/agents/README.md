# Consumer AI agents

These agent definitions are for downstream igaming operators building on `@oss/*`. Copy them into your repo's `.claude/agents/` directory.

## Setup

```bash
# After installing @oss/mcp
cp node_modules/@oss/mcp/agents/*.md .claude/agents/
```

Or copy manually from this directory.

## Agents

| Agent | Use when |
|---|---|
| `igaming-builder` | Configuring extensions.config.ts, swapping adapters, writing overlay plugins, customizing UI |
| `igaming-expert` | Turning a product ask into requirements + AC for your specific igaming features |
| `igaming-qa` | Writing E2E tests and triaging bugs (yours vs. OSS core) |
| `igaming-debugger` | Root-causing a failure - build-time (Next/Turbopack, tsc, module resolution) or runtime (Chrome DevTools) |

## MCP server

These agents reference tools from the `@oss/mcp` server. Add it to your `.mcp.json`:

```json
{
  "mcpServers": {
    "oss": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/@oss/mcp/dist/main.js", "--catalog", "docs/catalog.json"]
    }
  }
}
```

Run `pnpm exec oss-mcp-init` after install to generate your `docs/catalog.json`.
