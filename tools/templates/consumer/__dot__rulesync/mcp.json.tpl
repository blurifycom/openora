{
  "$schema": "https://github.com/dyoshikawa/rulesync/releases/latest/download/mcp-schema.json",
  "mcpServers": {
    "oss": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "tsx", "{{ossFromRoot}}/apps/mcp-server-dev/src/main.ts"]
    }
  }
}
