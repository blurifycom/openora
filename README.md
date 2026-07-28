# OSS iGaming Framework

[![Pipeline](https://github.com/blurifycom/openora/actions/workflows/pipeline.yml/badge.svg?branch=dev)](https://github.com/blurifycom/openora/actions/workflows/pipeline.yml)
[![npm](https://img.shields.io/npm/v/@openora/core?label=%40openora%2Fcore)](https://www.npmjs.com/package/@openora/core)
[![canary](https://img.shields.io/npm/v/@openora/core/canary?label=canary&color=orange)](https://www.npmjs.com/package/@openora/core?activeTab=versions)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-26%2B-339933?logo=node.js&logoColor=white)](#requirements)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-F69220?logo=pnpm&logoColor=white)](#requirements)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-v2.1-ff69b4.svg)](./CODE_OF_CONDUCT.md)
[![Discussions](https://img.shields.io/github/discussions/blurifycom/openora?label=discussions&color=6f42c1)](https://github.com/blurifycom/openora/discussions)

> Open-source, headless, plugin-based, AI-native iGaming framework. Clone it, extend it, deploy it - without forking core.

The platform ships the backend surface (auth, wallet, player management, compliance, audit, chat, backoffice) as composable modules and a typed SDK. Game lobby and CMS are early; bonuses, tournaments, affiliates and jackpots are not built yet - the order is being picked in [Discussions](https://github.com/blurifycom/openora/discussions/24). Your frontend, branding, and vendor adapters live in your own consumer repo and talk to it over HTTP. Nothing operator-specific lives here.

> [!WARNING]
> **Status: alpha (pre-1.0).** Contracts, package layout, and APIs may change between releases. Not yet recommended for production without your own review. See the [roadmap](#roadmap).

## Highlights

- **Headless by design** - backend modules, contracts, and an SDK consumption surface only. No UI ships here; you own the frontend.
- **Plugin host** - `definePlugin({ id, dependsOn, register })` is the single way new functionality enters the system. Overlay a folder or install an npm package; same contract.
- **Zod-first contracts** - every shape is a Zod schema; types are inferred, never hand-written. Routes are oRPC on Hono with OpenAPI emitted at build time.
- **Explicit wiring** - a small functional DI container with typed tokens. No decorators, no auto-discovery; everything is greppable.
- **Swappable vendor seams** - PSP, KYC, aggregator, chat, realtime transport, job queue, and message broker are ports with default in-process drivers and adapter overrides.
- **Regulatory audit log** - append-only, sha256 hash-chained. Every state-changing action leaves a trail.
- **AI-native** - an `AGENTS.md` in every module, scaffolders as slash commands, a queryable MCP dev server, and a generated machine-readable `catalog.json`.

## Table of contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [Extending the platform](#extending-the-platform)
- [Build your own iGaming on top](#build-your-own-igaming-on-top)
- [Frontend](#frontend)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Community](#community)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Requirements

Node 26+, pnpm 11+, Docker.

## Quick start

Two ways to get the API up at `http://localhost:3001`. Demo credentials after seeding: `admin@oss.dev` / `password123`.

### 1. Via agents / MCP (one command)

For agents (Claude Code, Copilot, Codex, Cursor) and anyone who wants a single onboarding step.

```bash
pnpm setup   # checks prereqs, installs deps, boots Postgres, runs migrations, prints a summary
pnpm db:seed          # demo data: admin + players + wallets + transactions + games
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
docker compose up -d                          # start Postgres + Redis (library-first: no app containers)
pnpm gen:drizzle             # generate Drizzle migrations
pnpm db:migrate                            # apply them
pnpm db:seed                                     # demo data
pnpm dev                                      # api :3001
```

`pnpm db:seed` is idempotent and deterministic. Flags: `--players=<n>`, `--admin-email=<e>`, `--admin-password=<p>`.

To run the whole reference stack in containers instead of on the host, use the opt-in profile: `docker compose --profile full up --build` (api :3001, web :3000, backoffice :3002).

## How it fits together

The platform is a pnpm + Turbo monorepo. `@openora/core` is the single published package, exposing subpaths (`/contracts`, `/server`, `/react`, and one per domain). Domains are wired into a domain-agnostic runtime through the composition root; overlay plugins extend it without touching core.

```text
apps/examples       # consumer reference implementation
apps/mcp-server-dev # MCP dev server (stdio) for agents
packages/core       # @openora/core - contracts, server engine, react SDK, all 15 modules
extensions.config.ts# the single registry of enabled plugins
```

See [docs/architecture.md](./docs/architecture.md) and the pillars + decision tree in [AGENTS.md](./AGENTS.md).

## Extending the platform

### Add a module

```bash
pnpm gen module <domain> <name>
```

Generates the module under `packages/core/src/<domain>/<name>/`, wires its domain barrels, `@openora/core` exports, contract slice, and `extensions.config.ts` entry. Run `pnpm regen && pnpm verify`. See [AGENTS.md](./AGENTS.md) for the full decision tree.

### Add an extension (overlay plugin)

Drop a folder under `extensions/<name>/` or point to an npm package. Both use the same `definePlugin` contract:

```typescript
// extensions/my-feature/plugin.ts
import { definePlugin } from '@openora/core/server';

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

## Build your own iGaming on top

Scaffold a consumer turborepo that links this checkout - it holds only what's unique to your operation (frontend, branding, vendor adapters, overlay plugins). Core is consumed as linked `@openora/*` packages, never forked.

```bash
pnpm create:app ../my-igaming --name my-igaming
cd ../my-igaming && pnpm install && pnpm dev
```

See [docs/downstream-consumer.md](./docs/downstream-consumer.md) for the full guide.

## Frontend

The platform is headless and ships no UI - backend modules + contracts + the SDK consumption surface only. The frontend (pages, components, styling, theme) lives in your consumer repo and talks to the api over HTTP via `@openora/core/react` (data hooks, auth, navigation, typed client). Use whatever UI stack you like.

## Roadmap

Planned work and progress live on the public board: **[openora roadmap](https://github.com/orgs/blurifycom/projects/1)**. Have a request or found a gap? [Open an issue](https://github.com/blurifycom/openora/issues/new/choose) and we triage it onto the board.

## Documentation

- Architecture: [docs/architecture.md](./docs/architecture.md)
- System design: [docs/system-design.md](./docs/system-design.md)
- Core concepts: [docs/core-concepts.md](./docs/core-concepts.md)
- Glossary (operator vs player, KYC, RTP, provably fair, rollover...): [docs/glossary.md](./docs/glossary.md)
- Pillars & decision tree: [AGENTS.md](./AGENTS.md)
- ADRs: [docs/adr/](./docs/adr/)
- Adapter binding guides (KYC, payment, ...): [docs/adapters/](./docs/adapters/)

## Community

[GitHub Discussions](https://github.com/blurifycom/openora/discussions) is where the project talks.

- [Q&A](https://github.com/blurifycom/openora/discussions/categories/q-a) - something does not run, or the docs do not cover it.
- [Ideas](https://github.com/blurifycom/openora/discussions/categories/ideas) - propose a module, an adapter, or a contract change; RFCs land here before any code.
- [Announcements](https://github.com/blurifycom/openora/discussions/categories/announcements) - releases, breaking changes, roadmap updates.
- [General](https://github.com/blurifycom/openora/discussions/categories/general) - introductions, what you are building, architecture talk.

Picking the next module happens in the open: [What should we build next?](https://github.com/blurifycom/openora/discussions/24)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, then run `pnpm verify` (typecheck + unit tests + lint + module-shape + boundary gate) before opening a PR. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Please do not file public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md) for private reporting.

## License

Dual-licensed: **AGPL-3.0-only** OR a **commercial license**.

- **Open source:** [GNU AGPL v3](./LICENSE). If you self-host, modify, or redistribute, you must make your complete corresponding source available under the same terms. **Section 13** extends this to network/SaaS use - running a modified version as a hosted service obliges you to offer its source to users.
- **Commercial:** for closed-source/SaaS deployments that cannot meet the AGPL's copyleft and network-use obligations, Blurify offers a separate commercial license. See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) - contact `contact@openora.ai`.

See [NOTICE](./NOTICE) for the attribution and dual-license summary.

> [!NOTE]
> This is software, not legal advice. Operating a real-money gambling service is heavily regulated - you are solely responsible for obtaining the required licenses and complying with the laws of every jurisdiction you serve. The software is provided "as is", without warranty of any kind.

Copyright (c) 2026 Blurify and contributors.
