# Consuming the platform from a downstream repo

How a downstream operator builds their own igaming on top of `@openora/*` without
forking core. The root `AGENTS.md` links here; this is the detail an agent loads only when
actually wiring a consumer.

See [`catalog.json`](./catalog.json) for the machine-readable surface (routes, schemas, adapter
tokens, slots, events, config schema) an agent reads instead of grepping `node_modules`.

## Fastest path: scaffold the repo

From this OSS checkout, generate a full consumer turborepo wired to link at it:

```bash
pnpm create:app ../my-igaming --name my-igaming
cd ../my-igaming
pnpm install
pnpm setup:mcp          # trust the MCP server + install the /start onboarding flow
pnpm build:oss          # build the linked @openora/* packages once
cp .env.example .env     # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate          # apply the OSS schema
pnpm dev                 # api :3001
```

The platform is **headless backend only** - it ships modules, contracts, and SDK consumption surface only. Build your entire frontend (player web, admin backoffice, components, styling, theme) in your own repo and consume the api over HTTP via `@openora/core/react`.

After install, run `pnpm setup:mcp` and then `/start` in Claude Code: it asks what you want to
build, calls the `enhance-intent` MCP tool to turn the ask into a grounded spec, and drives the
matching scaffold flow. See [mcp-setup.md](./mcp-setup.md#zero-config-setup-pnpm-setupmcp).

This emits a headless api consumer: `apps/api` (thin `createApp` entry +
`extensions.config.ts`), root `pnpm.overrides` linking every `@openora/*`, `.mcp.json`, the three
consumer AI agents, and `turbo/generators/` (`pnpm gen plugin|adapter`). The CLI lives at
`tools/create/create-igaming-app.ts`; the base tree at `tools/templates/consumer/`. Read on to
understand what it generated and how to extend it.

### Frontend

Your entire frontend lives in your own repo (the platform is headless backend only). It consumes the api over HTTP through `@openora/core/react` (data hooks, auth, transport, cross-cutting helpers). A consumer fetches data through these hooks and manages its own SSR/hydration. React/react-dom/@tanstack/react-query are deduped via the consumer's bundler alias so the linked `@openora/*` and the app share a single physical React copy.

## API entrypoint

A downstream consumer imports `@openora/core/server` + `@openora/core/contracts` and creates an API
instance. `createApp` is domain-agnostic - the consumer composes its own contract and injects
its PAM identity tables (ADR-0025/0026: single-tenant):

```typescript
// my-igaming/apps/api/src/main.ts
import { createApp } from '@openora/core/server';
import { composeContract } from '@openora/core/contracts';
import { user, session, account, verification, twoFactor } from '@openora/core/pam/schema/identity';
import { identityContract } from '@openora/core/pam/contracts/identity';
import { walletContract } from '@openora/core/wallet/contract';
import { extensions } from './extensions.config.js'; // their own plugin list

// Compose only the modules you enable (composeContract adds `health` itself).
const contract = composeContract({ identity: identityContract, wallet: walletContract });

const { listen, emitOpenApiSpec } = await createApp({
  plugins: extensions,
  contract,
  authSchema: { user, session, account, verification, twoFactor },
  port: 3001,
  cors: { origins: ['https://my-igaming.example'] },
  openapi: { info: { title: 'my-igaming API', version: '1.0.0' } },
});

await listen();
await emitOpenApiSpec();
```

Downstream consumers create their own thin entrypoint that calls `createApp` and bring
their own `extensions.config.ts`. See `tools/templates/consumer/apps/api/src/main.ts` for the reference.

## Seeding reference data (production)

Migrations carry **structure only** (DDL: tables, indexes, constraints) - never data.
Reference data a module needs to function (e.g. IAM's predefined backoffice roles) is seeded
separately by **module seeders** - a function each module exports from its `/seed` subpath
(e.g. `seedRoles` from `@openora/core/iam/seed`). They are **convergent upserts**
(`ON CONFLICT ... DO UPDATE`), so editing the declared data and re-running reconciles existing
rows - safe to run on every deploy.

Seeding is a **standalone one-shot script**, exactly like migrations (the `openora-migrate` bin shipped
by `@openora/core` imports every `migrate()` callable and runs them). It needs only a DB connection - it never boots the
app (no HTTP, no auth, no plugin host), so it is cheap and carries zero footprint in the running
server. You compose the seeders you want explicitly, then run it after migrations:

```typescript
// my-igaming/apps/api/src/seed.ts  - run after `db:migrate`, before/at release
import { createDrizzleDb } from '@openora/core/server';
import { seedRoles } from '@openora/core/iam/seed';
// import additional module seeders here as you enable them

const db = createDrizzleDb(process.env.DATABASE_URL!);

await seedRoles(db);
// await seedOtherModule(db);
console.log('Reference data seeded.');
```

Wire it as its own command (e.g. `"db:seed": "tsx src/seed.ts"`) and run it in your release
pipeline right after `pnpm db:migrate`. Because the seeders are idempotent upserts, re-running on
each deploy is the intended pattern. Composition is explicit (like `extensions.config.ts`): enable
a module's seeder by adding its one import + call - the same trade-off the migration runner makes.

### Running a single module's seeder

Each seeder is a plain `(db) => Promise<void>` function with no runtime coupling, so you can run
any one in isolation, in any order - you are never forced to seed everything at once. Drive this
however suits your pipeline:

```typescript
import { createDrizzleDb } from '@openora/core/server';
import { seedRoles } from '@openora/core/iam/seed';

const db = createDrizzleDb(process.env.DATABASE_URL!);
await seedRoles(db); // only IAM roles
```

Common orchestration patterns:

- **One script per module** - `db:seed:iam`, `db:seed:casino`, ... each importing a single seeder.
- **One script with a flag** - `pnpm db:seed --only=iam` branches on the arg.
- **One combined script** - imports and runs them all (the default `apps/api/src/seed.ts` above).

**Demo/fake data** (sample players, transactions) is a separate, dev-only concern - it lives in
`@openora/testing` (`seedDemoData` / `seedMinimal`) and must never run on production.

## Building the frontend (in your own repo)

Your entire frontend repo is built from scratch - pages, components, admin shell, theme, styling. It consumes the api over HTTP through `@openora/core/react` (typed client, data hooks, auth, realtime transport).

Wrap your root layout with `QueryClientProvider` and `ApiClientProvider` (from `@openora/core/react`):

```tsx
// your-frontend/app/providers.tsx (client component)
import { ApiClientProvider } from '@openora/core/react';
import './globals.css'; // your own styling and design system

<ApiClientProvider client={{ baseUrl }}>{children}</ApiClientProvider>;
```

### Styling and components

The platform ships no UI - your frontend owns all components, styling, and theme. Pick whatever
you like (Tailwind + DaisyUI, MUI, your own design system); OSS only feeds you data via the
hooks. If you use Tailwind v4 + DaisyUI, enable it in your own CSS build with a
`postcss.config.mjs` (`{ plugins: ['@tailwindcss/postcss'] }`) - or the `@tailwindcss/vite`
plugin for a Vite/TanStack app - and a global stylesheet:

```css
@import 'tailwindcss';
@plugin "daisyui";
```

Cross-workspace `link:` requires a dedup alias in your frontend bundler config for `react`,
`react-dom`, and `@tanstack/react-query` (single physical path). See ADR-0005.

For the same reason, a linked consumer's own Drizzle code (tables + operators) must import from
`@openora/core/server/orm`, NOT from `drizzle-orm` directly. A direct `drizzle-orm` import resolves to the
consumer's own physical copy; drizzle's protected-member classes then fail nominal type checks
against `DrizzleService.db` (which uses `@openora/core/server`'s copy). `@openora/core/server/orm` re-exports the
framework-free drizzle surface from the single shared instance.

Full hooks guide: `packages/core/src/react/AGENTS.md`.

## Local dev linking to a sibling consumer

Until OSS packages are published to npm, downstream consumers point at this workspace via
`pnpm.overrides` + `link:`. From the consumer's `package.json`:

```jsonc
"pnpm": {
  "overrides": {
    // Everything is folded into one package (ADR-0025): link @openora/core and you
    // get every domain as a subpath.
    "@openora/core": "link:../oss/packages/core"
  }
}
```

Each linked package's `main` resolves to `./dist/index.js`, so the consumer reads BUILT output.
To keep the link hot during dev, run a watch build here in parallel with the consumer's dev
process:

```bash
pnpm -F @openora/core build --watch
```

Modules under `packages/core/src/<domain>/*` are loaded by the consumer via `extensions.config.ts`
paths pointing at built plugin files - see the load pattern below.

Rejected alternatives: `pnpm link --global` (legacy, leaks state), `yalc` (extra publish step
on every change), `file:` (snapshot copy on install, no live source).

## Consumer load pattern

Consumer `extensions.config.ts` points at the built plugin files inside `@openora/core`
(`.../packages/core/dist/<domain>/<module>/src/plugin.js`), not source, because tsx in the
consumer's API entry can't reliably resolve the tsconfig. Always build `@openora/core`
before booting the consumer:

```bash
pnpm -F @openora/core build
```

For a watch loop during development:

```bash
pnpm -F @openora/core --parallel build --watch
```

Paths in the consumer's `extensions.config.ts` resolve relative to that config file's own
directory.

## Tooling notes

- Drizzle tables live in each module's `src/schema/index.ts`. `drizzle.config.ts` (in `@openora/core/server`)
  globs those files; `pnpm regen` runs drizzle-kit to generate migrations. There is no
  schema-merge step.
- All 15 core modules compile together as part of `@openora/core` (`tsc`, rootDir
  `packages/core/src`, emitting `dist/<domain>/<module>/src/...`).
- `pnpm-workspace.yaml#allowBuilds` (pnpm 11 syntax) replaces the legacy
  `pnpm.onlyBuiltDependencies` in package.json.
- A consumer gets the same AI surface this repo has by running the published `@openora/mcp` server
  against their own repo (see its README) and reading the generated `catalog.json`.
