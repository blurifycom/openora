# {{Name}} Extension Plugin - AGENTS.md

This is an overlay plugin under `apps/extensions/{{name}}/`.

## What it does

<!-- Describe what this extension adds or overrides -->

## How it hooks in

- Routes added: <!-- list oRPC routes -->
- Slots filled: <!-- list UI slot names -->
- Events listened: <!-- list event types -->
- MCP tools added: <!-- list tool names -->

## To extend this extension

Edit `plugin.ts`. Run `pnpm verify` after any change. If adding new routes or tables, follow the same patterns as a core module (see root AGENTS.md).
