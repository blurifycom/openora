# Quickstart

Get the framework running locally and boot an API on top of it. Budget about 30 minutes on a
first run: most of it is dependency install and the first build.

This repo is a library, not a server. It ships `@openora/core` and the tooling around it -
there is no API to boot here. The runnable API lives in a consumer app you generate with
`pnpm create:app`. So a first run has two parts: set up this repo (database, migrations,
demo data), then generate and start an app.

## Before you start

- **Node 26.13.1+** (`node --version`). The repo has an `.nvmrc`.
- **pnpm 12** (`pnpm --version`). The repo pins `pnpm@12.21.0`; `corepack enable` picks it up.
- **Docker** with Compose, running.
- **Free ports.** `docker compose up -d` starts these on the host:

  | Port  | Service                      |
  | ----- | ---------------------------- |
  | 5432  | Postgres (dev database)      |
  | 6379  | Redis                        |
  | 5434  | Postgres (integration tests) |
  | 6380  | Redis (integration tests)    |
  | 5672  | RabbitMQ                     |
  | 15672 | RabbitMQ management UI       |
  | 3001  | The API you start later      |

  If one is taken, stop what holds it or change the host port in `docker-compose.yml`.

## 1. Set up the framework repo

1. Clone `https://github.com/blurifycom/openora.git` and enter the checkout.
2. Run `pnpm run setup`.

Use `pnpm run setup`, not `pnpm setup`: the bare form runs pnpm's own built-in `setup`
command. The script checks prerequisites, installs dependencies, regenerates derived files,
starts the containers, builds the packages the database tools import, and applies
migrations. It stops on the first error.

**You should see** `=== Setup complete ===` and `docker compose ps` listing Postgres and
Redis as healthy.

Then load demo data with `pnpm db:seed`.

**You should see** a summary of seeded roles, players and games. The seed creates an admin
user `admin@oss.dev` with password `password1234`. Flags: `--players=<n>`,
`--admin-email=<e>`, `--admin-password=<p>`. It is idempotent, so re-running is safe.

### The same steps by hand

1. `pnpm install`.
2. Copy `packages/core/.env.example` to `.env` at the repo root; the db tools read `DATABASE_URL` from it.
3. `docker compose up -d` starts Postgres, Redis, RabbitMQ and the test databases.
4. `pnpm regen` refreshes tsconfig paths, Drizzle migrations and the catalog.
5. Build `@openora/testing` and everything it depends on with `pnpm --filter "@openora/testing..." build`; the db tools import the built packages.
6. `pnpm db:migrate`.
7. `pnpm db:seed`.

## 2. Run an API

Scaffold a consumer app. It installs `@openora/core` from npm, registers every core module
against the plugin host, and never forks the framework:

1. `pnpm create:app my-gaming-core` creates the app inside this clone; enter its directory.
2. `pnpm install`.
3. `pnpm bootstrap` writes `.env`, starts Postgres and Redis in Docker, applies the schema, and seeds an admin and demo data.
4. `pnpm dev`.

> Known issue: `@openora/core` 0.4.0 on npm ships without the `openora-migrate` bin, so the
> app's `pnpm db:migrate` fails until the next release.

The defaults in `.env.example` point at the containers from step 1 (`DATABASE_URL`,
`REDIS_URL`) and include a local-only `AUTH_SECRET`, so a local run needs no edits. Replace
`AUTH_SECRET` with a random value of 32+ characters anywhere else.

**You should see** the API listening on port 3001. Check it with `curl` on `http://localhost:3001/health`, which answers with an `ok` status and a timestamp.

Open `http://localhost:3001/docs` for the API reference of every route, generated from the
live contract, and `http://localhost:3001/openapi.json` for the raw spec.

> `pnpm dev` in the _framework_ repo runs the MCP dev server, not an API.

## Troubleshooting

- **`ERR_PNPM_...` or a "setup" that installs pnpm globally** - you ran `pnpm setup`. Run
  `pnpm run setup`.
- **`ERR_MODULE_NOT_FOUND` for a `dist/` path on `db:migrate` or `db:seed`** - the packages
  are not built yet. Run `pnpm --filter "@openora/testing..." build`.
- **`port is already allocated` from Docker** - another stack holds one of the ports above.
  Stop it, or change the host port in `docker-compose.yml` and the matching URL in `.env`.
- **The API exits on boot** - check that Postgres and Redis are up (`docker compose ps`) and
  that `.env` has `DATABASE_URL`, `REDIS_URL` and `AUTH_SECRET`.

## Add a module

Scaffold a module - schema, service, router, contract slice, and `plugin.ts` are generated
and registered for you:

1. `pnpm gen module` with a domain and a name (for example `casino` and `tournaments`) creates `packages/core/src/<domain>/<name>` and registers it.
2. Run `pnpm regen`, then `pnpm verify`.

Fill the regions marked with an `AGENT: implement here` comment; leave the wiring alone. See
[Core concepts](../platform/core-concepts.md) for what each generated file does.

`gen module`, `route`, `config`, `event`, `service` and `app` are core-only generators - they
run inside this monorepo. In a consumer repo you extend through overlays instead:
`pnpm gen plugin <name>` and `pnpm gen adapter`.

## Next

- [Core concepts](../platform/core-concepts.md) - plugins, contracts, services, adapters, events.
- [Consuming the framework downstream](./downstream-consumer.md) - build your product on top.
- [Agent quickstart](./agent-quickstart.md) - drive the same workflow from an AI agent.
