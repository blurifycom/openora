# {{name}}

An igaming platform built on the open-source `@openora/*` packages. This repo holds only
what is unique to your operation - branding, vendor adapters, and overlay plugins. The
core (auth, wallet, gaming, lobby, compliance, backoffice, CMS) is consumed as linked
packages and never forked.

This is a headless api consumer. Build your frontend (player web + admin backoffice)
in its own repo and talk to this api over HTTP via `@openora/react`.

## Layout

```
apps/
  api/          # Hono + oRPC API (:3001) - thin createApp entry + your extensions.config.ts
.claude/agents/ # AI agents: builder, expert, qa
turbo/generators/ # turbo gen: plugin, adapter
```

## Prerequisites

The `@openora/*` packages install straight from npm - no sibling checkout needed. The generated
`devDependencies`/`dependencies` track the `latest` stable tag, so a fresh install always pulls the
newest release; pin an exact version if you need reproducible installs.

## Dev setup

```bash
pnpm install               # pulls @openora/* from npm
pnpm setup:mcp             # trust the MCP server + install the /start onboarding flow
pnpm regen                 # regenerate OpenAPI + catalog + Drizzle client (after schema changes)
cp .env.example .env       # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate            # apply the OSS schema to your database
pnpm dev                   # api :3001
```

After `pnpm setup:mcp`, restart your editor and run **`/start`** in Claude Code - it asks what
you want to build and scaffolds it for you.

To pull the newest platform release, re-run `pnpm install` (the pin tracks the `latest` stable tag).

## Extending

| Need | Command |
|---|---|
| Overlay plugin (new behavior/routes) | `pnpm gen plugin` |
| Swap a vendor adapter (KYC / payment / notification) | `pnpm gen adapter` |

Register new plugins in `apps/api/src/extensions.config.ts`. Adapters that override a
default binding must be listed AFTER the module that owns the default (last registration of
a DI token wins).

## AI agents

`.claude/agents/` ships three agents scoped to this repo:

- `builder` - configure extensions, swap adapters, write overlays, customize UI
- `expert` - turn product asks into requirements + acceptance criteria
- `qa` - write/run Playwright E2E tests and triage bugs

The `oss` MCP server (`.mcp.json`) gives them read-only inspection of the platform surface.
