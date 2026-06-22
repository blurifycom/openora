# Quickstart

Get the API running at `http://localhost:3001` and call your first route. Requires Node 26+,
pnpm 11+, and Docker.

## Run it

The fastest path checks prerequisites, installs deps, boots Postgres, applies migrations, and
seeds demo data:

```bash
pnpm setup:agent   # prereqs + deps + Postgres + migrations
pnpm seed          # demo data: admin + players + wallets + games
pnpm dev           # api on :3001
```

Prefer the explicit steps?

```bash
pnpm install
docker compose up -d                  # Postgres only (library-first)
pnpm -F @blurifycom/core/server generate     # generate Drizzle migrations
pnpm -F @blurifycom/core/server migrate      # apply them
pnpm seed
pnpm dev
```

Seeding logs you in with `admin@oss.dev` / `password123`. Flags: `--players=<n>`,
`--admin-email=<e>`, `--admin-password=<p>`.

## Call a route

```bash
curl http://localhost:3001/health
```

Every route is browsable in the [API reference](/docs/api), generated from the live contract.

## Add a module

Scaffold a standalone module - schema, service, router, contract slice, and `plugin.ts` are
generated and registered for you:

```bash
pnpm gen module tournaments   # creates @blurifycom-addons/tournaments + registers it
pnpm regen && pnpm verify
```

Fill the `// AGENT: implement here` regions; leave the wiring alone. See
[Core concepts](/docs/core-concepts) for what each generated file does.

## Next

- [Core concepts](/docs/core-concepts) - plugins, contracts, services, adapters, events.
- [Consuming the platform downstream](/docs/downstream-consumer) - build your igaming on top.
