# Quickstart

Get the platform running locally and scaffold an app on top of it. Requires Node 26+,
pnpm 11+, and Docker.

This repo is a library, not a server. It ships `@openora/core` and the tooling around it -
there is no `apps/api` here to boot. The runnable API lives in a consumer app you generate
with `pnpm create:app`.

## Set up the framework repo

The fastest path checks prerequisites, installs deps, boots Postgres, and applies migrations:

```bash
pnpm setup   # prereqs + deps + Postgres + migrations
pnpm db:seed          # demo data: admin + players + wallets + games
```

Prefer the explicit steps?

```bash
pnpm install
docker compose up -d                  # Postgres only (library-first)
pnpm gen:drizzle        # generate Drizzle migrations
pnpm db:migrate                   # apply them
pnpm db:seed
```

Seeding logs you in with `admin@oss.dev` / `password123`. Flags: `--players=<n>`,
`--admin-email=<e>`, `--admin-password=<p>`.

## Run an API

Scaffold a consumer app. It installs `@openora/core` from npm, registers every core module
against the plugin host, and never forks the framework:

```bash
pnpm create:app my-gaming-core
cd my-gaming-core
pnpm install
cp .env.example .env                  # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate
pnpm dev                              # api on :3001
```

```bash
curl http://localhost:3001/health
```

Every route is browsable in the [API reference](/docs/api), generated from the live contract.

> `pnpm dev` in _this_ repo runs the MCP dev server, not an API.

## Add a module

Scaffold a module - schema, service, router, contract slice, and `plugin.ts` are generated
and registered for you:

```bash
pnpm gen module casino tournaments   # creates packages/core/src/casino/tournaments + registers it
pnpm regen && pnpm verify
```

Fill the `// AGENT: implement here` regions; leave the wiring alone. See
[Core concepts](/docs/core-concepts) for what each generated file does.

`gen module`, `route`, `config`, `event`, `service` and `app` are core-only generators - they
run inside this monorepo. In a consumer repo you extend through overlays instead:
`pnpm gen plugin <name>` and `pnpm gen adapter`.

## Next

- [Core concepts](/docs/core-concepts) - plugins, contracts, services, adapters, events.
- [Consuming the platform downstream](/docs/downstream-consumer) - build your igaming on top.
