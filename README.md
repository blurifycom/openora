# OSS Casino Platform

Open-source, headless, plugin-based, AI-native casino platform. Clone it, extend it, deploy it - without forking core.

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
- **Casino Aggregator** - single aggregator adapter port (mock included)

## Quick start

```bash
# Requirements: Node 22+, pnpm 10+, Docker
pnpm setup:agent          # boot Docker (Postgres + Redis) + run migrations
pnpm seed                 # demo data: admin + players + wallets + transactions + games
pnpm dev                  # api :3001, backoffice :3000, worker :3003, storybook :6006
```

Log in to the backoffice with `admin@oss.dev` / `password123` (see `pnpm seed --help` flags).

## Adding a module

```bash
pnpm scaffold module <name>
```

Generates the full module skeleton under `packages/modules/<name>/` and registers it in `extensions.config.ts`. See [AGENTS.md](./AGENTS.md) for the complete decision tree.

## Adding an extension (overlay plugin)

Drop a folder under `apps/extensions/<name>/` or point to an npm package. Both paths use the same `definePlugin` contract:

```typescript
// apps/extensions/my-feature/plugin.ts
import { definePlugin } from '@oss/plugin-host';

export default definePlugin({
  id: 'my-feature',
  dependsOn: ['identity', 'wallet'], // optional load-order hint
  register(ctx) {
    ctx.providers.add(MyService);
    ctx.controllers.add(MyController); // oRPC @Implement controller
    ctx.slots.fill('sidebar-bottom', MyWidget);
    ctx.events.on('wallet.deposit.completed', handler);
    ctx.prisma.extend('User', 'myField String?');
    ctx.mcp.tool({ name: 'my-tool', description: '...', handler });
  },
});
```

Then register in `extensions.config.ts`:

```typescript
export const extensions = [
  // ...existing modules
  { id: 'my-feature', path: './apps/extensions/my-feature/plugin.ts' },
];
```

## Examples

| Example                                                              | What it shows                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`examples/consumer-games-plugin/`](./examples/consumer-games-plugin/) | PvP "Crash" game as a plugin: custom routes, provider override, event subscription, UI slot injection |
| [`examples/sportsbook-plugin/`](./examples/sportsbook-plugin/)       | Sportsbook (Betby) integration: port-based adapter, webhook callback, large isolated domain as plugin |

## Architecture

```
Single Zod root  ->  oRPC contract  ->  NestJS controller  ->  OpenAPI spec
                                    ->  TypeScript client (zero codegen)
```

Full system diagram (plugin host, adapter seams, consumer linking, AI dev surface): [docs/architecture.md](./docs/architecture.md).

Pillars: [AGENTS.md](./AGENTS.md) | ADRs: [docs/adr/](./docs/adr/)

## Extending the UI

Module pages consume only `@oss/ui-provider-contract`. Swap the entire look by replacing `@oss/ui-provider-shadcn` with your own adapter package. No module changes needed.

## AI-first development

Every module ships an `AGENTS.md`. The MCP dev server (`apps/mcp-server-dev`) exposes the schema registry, route catalog, plugin manifest, and scaffolders as tools - so an agent can extend the platform without re-asking the same questions every session.

It is a **stdio** server registered in [`.mcp.json`](./.mcp.json) (pre-approved via `enabledMcpjsonServers` in `.claude/settings.json`) - the editor launches it; there is no port and no separate `dev` command. Codex reads the same definition from [`.codex/config.toml`](./.codex/config.toml).

```bash
claude mcp list           # verify the oss-dev server is connected
```

Then use `list-modules`, `list-routes`, `query-openapi`, `get-prisma-model-graph`, `propose-prisma-change`, and the `scaffold-*` tools. Write operations go through `/scaffold-module`, `/scaffold-plugin`, `/scaffold-route`, `/scaffold-ui-component` (deterministic code-mods). See [docs/agent-quickstart.md](./docs/agent-quickstart.md).

## License

MIT
