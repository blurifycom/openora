# OSS iGaming Platform

Open-source, headless, plugin-based, AI-native igaming platform. Clone it, extend it, deploy it - without forking core.

## What's included

- **Auth** - better-auth: email/password, 2FA, session management
- **Wallet** - balance, deposits, withdrawals (bring your own PSP adapter)
- **Gaming** - game provider integration layer, provably-fair primitives (bring your own aggregator)
- **Lobby** - categorized game feeds, featured slots, search
- **Chat** - global + room chat, soft moderation
- **Bonus** - welcome bonus, deposit match, wagering rollover engine
- **Compliance** - deposit/wagering limits, geo-block adapter
- **Notifications** - in-app notifications, delivery port
- **CMS** - pages + banners, JSON content blocks
- **Localization** - i18next-compatible, DB-backed string overrides
- **Backoffice** - admin API (stats, user management, transaction history)
- **iGaming Aggregator** - single aggregator adapter port (mock included)

## Quick start

```bash
# Requirements: Node 26+, pnpm 11+, Docker
pnpm setup:agent          # boot Docker (Postgres) + run migrations
pnpm seed                 # demo data: admin + players + wallets + transactions + games
pnpm dev                  # api :3001
```

The API starts at `http://localhost:3001`. Demo credentials: `admin@oss.dev` / `password123` (see `pnpm seed --help` flags).

## Adding a module

```bash
pnpm gen module <group> <name>   # group: player | backoffice | platform
```

Generates the full module skeleton under `packages/modules/<group>/<name>/` (part of the single `@oss/modules` package) and registers it in `extensions.config.ts`. See [AGENTS.md](./AGENTS.md) for the complete decision tree.

## Adding an extension (overlay plugin)

Drop a folder under `apps/api/src/extensions/<name>/` or point to an npm package. Both paths use the same `definePlugin` contract:

```typescript
// apps/api/src/extensions/my-feature/plugin.ts
import { definePlugin } from '@oss/plugin-host';

export default definePlugin({
  id: 'my-feature',
  dependsOn: ['identity', 'wallet'], // optional load-order hint
  register(ctx) {
    ctx.provide(MY_ADAPTER, () => new MyAdapter()); // bind a vendor seam
    ctx.routers.add('myFeature', (c) => createMyRouter(new MyService(c.get(DRIZZLE)))); // oRPC router
    ctx.slots.fill('sidebar-bottom', MyWidget);
    ctx.events.on('wallet.deposit.completed', handler);
    ctx.mcp.tool({ name: 'my-tool', description: '...', handler });
  },
});
```

Then register in `extensions.config.ts`:

```typescript
export const extensions = [
  // ...existing modules
  { id: 'my-feature', path: './apps/api/src/extensions/my-feature/plugin.ts' },
];
```

## Building your own igaming on top (downstream consumer)

Scaffold a consumer turborepo that links this checkout:

```bash
pnpm create:app ../my-igaming --name my-igaming
cd ../my-igaming
pnpm install
pnpm build:oss      # build the linked @oss/* packages once
pnpm dev            # api :3001
```

The generated repo holds only what's unique to your operation - frontend (pages, components, styling, theme), branding, vendor adapters, and overlay plugins. Core is consumed as linked `@oss/*` packages, never forked. It ships `turbo gen` generators (`pnpm gen plugin|adapter`) and AI agents in `.claude/agents/`.

See [docs/downstream-consumer.md](./docs/downstream-consumer.md) for the full consumption guide.

## Architecture

```
Single Zod root  ->  oRPC contract  ->  Hono + oRPC handler  ->  OpenAPI spec
                                    ->  TypeScript client (zero codegen)
```

Full system diagram (plugin host, adapter seams, consumer linking, AI dev surface): [docs/architecture.md](./docs/architecture.md).

New to the terms (operator vs player, KYC, RTP, provably fair, rollover...)? See the [glossary](./docs/glossary.md).

Pillars: [AGENTS.md](./AGENTS.md) | ADRs: [docs/adr/](./docs/adr/)

## Frontend

The platform is headless and ships no UI - it exposes backend modules + contracts + the SDK consumption surface only. The frontend (all pages, components, styling, theme) lives in your downstream consumer repo and talks to the api over HTTP via `@oss/react` (data hooks, auth, navigation, typed client). Use whatever UI stack you like.

## AI-first development

Every module ships an `AGENTS.md`. The MCP dev server (`apps/mcp-server-dev`) exposes the schema registry, route catalog, plugin manifest, and scaffolders as tools - so an agent can extend the platform without re-asking the same questions every session.

It is a **stdio** server registered in [`.mcp.json`](./.mcp.json) (pre-approved via `enabledMcpjsonServers` in `.claude/settings.json`) - the editor launches it; there is no port and no separate `dev` command.

```bash
claude mcp list           # verify the oss-dev server is connected
```

Then use `list-modules`, `list-routes`, `query-openapi`, `get-drizzle-schema`, `propose-table-change`, `schema-get`, `docs-search`, `db-query-readonly`, and the `scaffold-*` tools. Write operations go through `/scaffold-module`, `/scaffold-plugin`, `/scaffold-route` (deterministic code-mods). See [docs/agent-quickstart.md](./docs/agent-quickstart.md).

## License

MIT
