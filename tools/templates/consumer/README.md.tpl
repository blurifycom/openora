# {{name}}

An igaming platform built on the open-source `@oss/*` packages. This repo holds only
what is unique to your operation - branding, vendor adapters, overlay plugins, and route
shims. The core (auth, wallet, gaming, lobby, compliance, backoffice, CMS) is consumed as
linked packages and never forked.

## Layout

```
apps/
  api/          # NestJS + oRPC API (:3001) - thin createApp entry + your extensions.config.ts
  web/          # Next.js player app (:3000) - mounts @oss/react-sdk player pages
  backoffice/   # Next.js admin app (:3002) - mounts @oss/react-sdk admin pages
.claude/agents/ # AI agents: igaming-builder, igaming-expert, igaming-qa
turbo/generators/ # turbo gen: plugin, adapter, page
```

## Dev setup

```bash
pnpm install
pnpm build:oss            # build the linked @oss/* packages once
cp .env.example .env       # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate            # apply the OSS schema to your database
pnpm dev                   # api :3001, web :3000, backoffice :3002
```

`@oss/*` is linked from a sibling OSS checkout (see `pnpm.overrides`). When you change OSS
source, rebuild it (`pnpm build:oss`) so the linked `dist/` updates. For a hot loop, run a
watch build in the OSS checkout in parallel.

## Extending

| Need | Command |
|---|---|
| Overlay plugin (new behavior/routes) | `pnpm gen plugin` |
| Swap a vendor adapter (KYC / payment / notification) | `pnpm gen adapter` |
| Mount an `@oss/react-sdk` page on a route | `pnpm gen page` |

Register new plugins in `apps/api/src/extensions.config.ts`. Adapters that override a
default binding must be listed AFTER the module that owns the default (last registration of
a DI token wins).

## AI agents

`.claude/agents/` ships three agents scoped to this repo:

- `igaming-builder` - configure extensions, swap adapters, write overlays, customize UI
- `igaming-expert` - turn product asks into requirements + acceptance criteria
- `igaming-qa` - write/run Playwright E2E tests and triage bugs

The `oss` MCP server (`.mcp.json`) gives them read-only inspection of the platform surface.
