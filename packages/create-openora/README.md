# @openora/create

[![npm](https://img.shields.io/npm/v/@openora/create)](https://www.npmjs.com/package/@openora/create)
[![canary](https://img.shields.io/npm/v/@openora/create/canary?label=canary&color=orange)](https://www.npmjs.com/package/@openora/create?activeTab=versions)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://github.com/blurifycom/openora/blob/dev/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-blurifycom%2Fopenora-181717?logo=github)](https://github.com/blurifycom/openora)

> The npm initializer for [Openora](https://github.com/blurifycom/openora) - scaffold a headless iGaming backend in one command. No clone, no fork.

`npm create @openora` writes a ready-to-run consumer app that pulls the platform ([`@openora/core`](https://www.npmjs.com/package/@openora/core)) from npm and wires every built-in module for you. Your branding, adapters, and overlays go on top - core stays an untouched dependency.

> **Status: alpha (pre-1.0).** The scaffold and the packages it installs may change between releases.

## Quick start

```sh
npm create @openora@latest my-casino
```

```sh
cd my-casino
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm dev
```

That's a full iGaming backend - accounts, wallet, casino lobby, chat, compliance, CMS, backoffice, audit - running locally, composed from published packages.

Works with any package manager: `pnpm create @openora`, `yarn create @openora`, or `npm create @openora`.

## What it scaffolds

```
my-casino/
  apps/api/                    # headless API - createApp() + your extensions
    src/
      main.ts                  # composes the module contracts, boots the server
      extensions.config.ts     # [...corePlugins(), ...your overlays]
      extensions/              # your plugins live here
  .mcp.json                    # @openora/mcp preconfigured for AI agents
  .env.example                 # DATABASE_URL, AUTH_SECRET, ...
  docker-compose.yml           # local postgres
```

- **Headless** - the API only. Build your frontend in the same repo and talk to it over HTTP with [`@openora/core/react`](https://www.npmjs.com/package/@openora/core).
- **Every core module enabled** via `corePlugins()`, resolved from your installed `@openora/core`. Opt one out with `corePlugins().filter((p) => p.id !== 'chat')`.
- **AI-native** - `.mcp.json` points at [`@openora/mcp`](https://www.npmjs.com/package/@openora/mcp) so an agent can discover routes, schemas, adapter seams, and events in your repo.

## Add your own capability

Inside the scaffolded app, `turbo gen` gives you the same generators the platform uses:

```sh
pnpm gen plugin    # new overlay plugin (routes / event handlers / jobs)
pnpm gen adapter   # swap a vendor adapter (payment / KYC / notification)
```

Overlays load after core, so a later `ctx.provide(TOKEN, ...)` wins - override a vendor seam without editing core.

## Canary channel

Every push to the platform's `dev` branch publishes an immutable canary of the whole `@openora/*` line (including this initializer) under the `canary` dist-tag:

```sh
npm create @openora@canary my-casino
```

Use it for pre-release testing, never production.

## License

[AGPL-3.0-only](https://github.com/blurifycom/openora/blob/dev/LICENSE). A commercial license is available - see [LICENSE-COMMERCIAL.md](https://github.com/blurifycom/openora/blob/dev/LICENSE-COMMERCIAL.md).
