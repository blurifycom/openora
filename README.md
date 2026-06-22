# OSS iGaming Platform

Open-source, headless, plugin-based, AI-native igaming platform. Clone it, extend it, deploy it - without forking core.

## Requirements

Node 26+, pnpm 11+, Docker.

## Installation & Run

Two ways to get the API up at `http://localhost:3001`. Demo credentials after seeding: `admin@oss.dev` / `password123`.

### 1. Via agents / MCP (one command)

For agents (Claude Code, Copilot, Codex, Cursor) and anyone who wants a single onboarding step.

```bash
pnpm setup:agent   # checks prereqs, installs deps, boots Postgres, runs migrations, prints a summary
pnpm seed          # demo data: admin + players + wallets + transactions + games
pnpm dev           # api :3001
```

The `oss-dev` MCP dev server is wired in [`.mcp.json`](./.mcp.json) (stdio, launched by the editor - no port). It exposes the schema registry, route catalog, plugin manifest, and scaffolders as tools so an agent can extend the platform without re-asking the same questions each session.

```bash
claude mcp list    # verify the oss-dev server is connected
```

Then use `list-modules`, `list-routes`, `query-openapi`, `get-drizzle-schema`, `propose-table-change`, `docs-search`, `db-query-readonly`, and the `scaffold-*` tools. See [docs/agent-quickstart.md](./docs/agent-quickstart.md).

### 2. Manual run

```bash
pnpm install                                  # install workspace deps
docker compose up -d                          # start Postgres (library-first: only the db)
pnpm -F @blurifycom/core/server generate             # generate Drizzle migrations
pnpm -F @blurifycom/core/server migrate              # apply them
pnpm seed                                     # demo data
pnpm dev                                      # api :3001
```

`pnpm seed` is idempotent and deterministic. Flags: `--players=<n>`, `--admin-email=<e>`, `--admin-password=<p>`.

To run the whole reference stack in containers instead of on the host, use the opt-in profile: `docker compose --profile full up --build` (api :3001, web :3000, backoffice :3002).

## Adding a module

```bash
pnpm gen module <name>
```

Generates a standalone `@blurifycom-addons/<name>` package under `packages/addons/<name>/` and registers it in `extensions.config.ts`. Run `pnpm regen && pnpm verify`. See [AGENTS.md](./AGENTS.md) for the full decision tree.

## Adding an extension (overlay plugin)

Drop a folder under `apps/api/src/extensions/<name>/` or point to an npm package. Both use the same `definePlugin` contract:

```typescript
// apps/api/src/extensions/my-feature/plugin.ts
import { definePlugin } from '@blurifycom/plugin-host';

export default definePlugin({
  id: 'my-feature',
  dependsOn: ['identity', 'wallet'], // optional load-order hint
  register(ctx) {
    ctx.provide(MY_ADAPTER, () => new MyAdapter()); // bind a vendor seam
    ctx.routers.add('myFeature', (c) => createMyRouter(c)); // oRPC router
    ctx.events.on('wallet.deposit.completed', handler);
    ctx.mcp.tool({ name: 'my-tool', description: '...', handler });
  },
});
```

Then register it in `extensions.config.ts`.

## Building your own igaming on top

Scaffold a consumer turborepo that links this checkout - it holds only what's unique to your operation (frontend, branding, vendor adapters, overlay plugins). Core is consumed as linked `@blurifycom/*` packages, never forked.

```bash
pnpm create:app ../my-igaming --name my-igaming
cd ../my-igaming && pnpm install && pnpm build:oss && pnpm dev
```

See [docs/downstream-consumer.md](./docs/downstream-consumer.md) for the full guide.

## Frontend

The platform is headless and ships no UI - backend modules + contracts + the SDK consumption surface only. The frontend (pages, components, styling, theme) lives in your consumer repo and talks to the api over HTTP via `@blurifycom/core/react` (data hooks, auth, navigation, typed client). Use whatever UI stack you like.

## Docs

- Architecture: [docs/architecture.md](./docs/architecture.md)
- Glossary (operator vs player, KYC, RTP, provably fair, rollover...): [docs/glossary.md](./docs/glossary.md)
- Pillars & decision tree: [AGENTS.md](./AGENTS.md)
- ADRs: [docs/adr/](./docs/adr/)

## License

Dual-licensed: **AGPL-3.0-only** OR a **commercial license**.

- Open source: [GNU AGPL v3](./LICENSE). If you self-host, modify, or redistribute, you must make your complete corresponding source available under the same terms. **Section 13** extends this to network/SaaS use - running a modified version as a hosted service obliges you to offer its source to users.
- Commercial: for closed-source/SaaS deployments that cannot meet the AGPL's copyleft and network-use obligations, [Licensor] offers a separate commercial license. See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) - contact `licensing@example.com`.

Copyright (c) 2026 [Licensor] and contributors.
