# @oss/mcp

Consumer-facing MCP server for the OSS igaming platform. It exposes the generated
platform catalog (`docs/catalog.json`) as read-only MCP tools so an AI agent
working in a downstream consumer repo (one that installs the `@oss/*` packages,
not the source tree) can discover what it can extend: modules, adapter swap-seams,
events, UI slots, contract schemas, and config fields.

This is the consumer analog of the contributor dev server (`apps/mcp-server-dev`),
which reads the live source tree. `@oss/mcp` instead reads the catalog snapshot
shipped in the published package, or a catalog you point it at.

## Tools

| Tool                | Args      | Purpose                                                 |
| ------------------- | --------- | ------------------------------------------------------- |
| `catalog-overview`  | -         | Start here: counts + adapter table + config fields.     |
| `list-adapters`     | -         | Vendor swap-seams: interface, token, wired-vs-stub.     |
| `list-routes`       | `module?` | oRPC route namespaces, optionally scoped to one module. |
| `list-events`       | -         | Cross-module domain events to subscribe to.             |
| `list-slots`        | -         | Named UI slots for extending the backoffice.            |
| `describe-module`   | `name`    | One module's tables + routes.                           |
| `schema-get`        | `name`    | Where a Zod contract schema is defined.                 |
| `get-config-schema` | -         | iGaming-config token, source, and fields.               |

All tools are read-only. If the catalog cannot be located, every tool returns a
helpful message instead of crashing.

## Catalog resolution

The server locates `catalog.json` at runtime (it never imports the JSON) in this
order:

1. `OSS_CATALOG` env var (absolute path), if set.
2. `<cwd>/docs/catalog.json`, then `<cwd>/node_modules/@oss/mcp/docs/catalog.json`,
   then walking up from `cwd` for a `docs/catalog.json`.
3. The package's own bundled snapshot (shipped in `docs/catalog.json`).

## Registering in a consumer's `.mcp.json`

```jsonc
{
  "mcpServers": {
    "oss": {
      "type": "stdio",
      "command": "npx",
      "args": ["@oss/mcp"],
      "env": {
        "OSS_CATALOG": "./node_modules/@oss/mcp/docs/catalog.json",
      },
    },
  },
}
```

## Keeping the catalog current

The catalog is regenerated upstream in the platform repo via `pnpm regen`
(which runs `tools/gen-catalog.ts`). A new `@oss/mcp` release ships the updated
snapshot; pin `OSS_CATALOG` to a freshly generated file to override it locally.
