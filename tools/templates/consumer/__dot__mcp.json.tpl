{
  "mcpServers": {
    "oss": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "tsx", "{{ossFromRoot}}/packages/platform/mcp/src/main.ts"]
    }
  }
}
