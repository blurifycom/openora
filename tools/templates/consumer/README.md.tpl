# {{name}}

An igaming platform built on the open-source `@oss/*` packages. This repo holds only
what is unique to your operation - branding, vendor adapters, and overlay plugins. The
core (auth, wallet, gaming, lobby, compliance, backoffice, CMS) is consumed as linked
packages and never forked.

This is a headless api consumer. Build your frontend (player web + admin backoffice)
in its own repo and talk to this api over HTTP via `@oss/react`.

## Layout

```
apps/
  api/          # Hono + oRPC API (:3001) - thin createApp entry + your extensions.config.ts
.claude/agents/ # AI agents: igaming-builder, igaming-expert, igaming-qa
turbo/generators/ # turbo gen: plugin, adapter
```

## Prerequisites

The `@oss/*` packages are consumed via `link:` from a sibling OSS checkout (see `pnpm.overrides`).
Clone both repos side by side BEFORE running `pnpm install`:

```
parent/
  igaming-oss/        # the OSS platform checkout
  {{name}}/           # this repo
```

Publishing to npm/GitLab is on the roadmap; until then the sibling checkout is required.

## Dev setup

```bash
pnpm install               # links @oss/* from the sibling checkout
pnpm setup:mcp             # trust the MCP server + install the /start onboarding flow
pnpm build:oss             # build the linked @oss/* packages once
pnpm regen                 # regenerate OpenAPI + catalog + Drizzle client (after schema changes)
cp .env.example .env       # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate            # apply the OSS schema to your database
pnpm dev                   # api :3001
```

After `pnpm setup:mcp`, restart your editor and run **`/start`** in Claude Code - it asks what
you want to build and scaffolds it for you.

When you change OSS source, rebuild it (`pnpm build:oss`) so the linked `dist/` updates. For a
hot loop, run a watch build in the OSS checkout in parallel.

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

- `igaming-builder` - configure extensions, swap adapters, write overlays, customize UI
- `igaming-expert` - turn product asks into requirements + acceptance criteria
- `igaming-qa` - write/run Playwright E2E tests and triage bugs

The `oss` MCP server (`.mcp.json`) gives them read-only inspection of the platform surface.
