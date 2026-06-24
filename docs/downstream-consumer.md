# Consuming the platform from a downstream repo

How a downstream operator builds their own igaming on top of `@blurifycom/*` without
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
pnpm build:oss          # build the linked @blurifycom/* packages once
cp .env.example .env     # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate          # apply the OSS schema
pnpm dev                 # api :3001
```

The platform is **headless backend only** - it ships modules, contracts, and SDK consumption surface only. Build your entire frontend (player web, admin backoffice, components, styling, theme) in your own repo and consume the api over HTTP via `@blurifycom/core/react`.

After install, run `pnpm setup:mcp` and then `/start` in Claude Code: it asks what you want to
build, calls the `enhance-intent` MCP tool to turn the ask into a grounded spec, and drives the
matching scaffold flow. See [mcp-setup.md](./mcp-setup.md#zero-config-setup-pnpm-setupmcp).

This emits a headless api consumer: `apps/api` (thin `createApp` entry +
`extensions.config.ts`), root `pnpm.overrides` linking every `@blurifycom/*`, `.mcp.json`, the three
consumer AI agents, and `turbo/generators/` (`pnpm gen plugin|adapter`). The CLI lives at
`tools/create-igaming-app.ts`; the base tree at `tools/templates/consumer/`. Read on to
understand what it generated and how to extend it.

### Frontend

Your entire frontend lives in your own repo (the platform is headless backend only). It consumes the api over HTTP through `@blurifycom/core/react` (data hooks, auth, transport, cross-cutting helpers). A consumer fetches data through these hooks and manages its own SSR/hydration. React/react-dom/@tanstack/react-query are deduped via the consumer's bundler alias so the linked `@blurifycom/*` and the app share a single physical React copy.

## API entrypoint

A downstream consumer imports `@blurifycom/core/server` + `@blurifycom/core/contracts` and creates an API
instance. `createApp` is domain-agnostic - the consumer composes its own contract and injects
its PAM identity tables (ADR-0025/0026: single-tenant):

```typescript
// my-igaming/apps/api/src/main.ts
import { createApp } from '@blurifycom/core/server';
import { composeContract } from '@blurifycom/core/contracts';
import { user, session, account, verification, twoFactor } from '@blurifycom/pam/schema/identity';
import { identityContract } from '@blurifycom/pam/contracts/identity';
import { walletContract } from '@blurifycom/wallet/contract';
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

The OSS `apps/api` is itself a thin consumer of `createApp` and serves as the reference.
Downstream consumers do NOT fork `apps/api` - they create their own thin entrypoint and bring
their own `extensions.config.ts`.

## Add-on packages

Some modules are not part of the default OSS build - they ship as separately distributed
`@blurifycom-addons/*` packages (e.g. `@blurifycom-addons/player-management` for admin PAM,
`@blurifycom-addons/sportsbook`, `@blurifycom-addons/leaderboard`, `@blurifycom-addons/aggregator`). A
add-on package is a normal `definePlugin` module that also ships its own contract
slice and migrations. To enable one you want:

1. `pnpm add @blurifycom-addons/<name>`.
2. Register its plugin in your `extensions.config.ts` (it exports a default plugin).
3. Merge its contract slice into the contract you pass to `createApp`, so OpenAPI +
   the typed client expose its routes:

   ```typescript
   import { composeContract } from '@blurifycom/core/contracts';
   import { walletContract } from '@blurifycom/wallet/contract';
   import { playerContract } from '@blurifycom-addons/player-management/contract';

   const contract = composeContract({ wallet: walletContract, player: playerContract });
   ```

4. If the package owns tables, run its migrations after the core set
   (`pnpm -F @blurifycom-addons/<name> db:migrate`, or the platform's `pnpm db:migrate:all`,
   which discovers every add-on package's migration set).

The core OSS build never references add-on packages (a lint boundary,
`no-core-to-addon`, enforces it), so you only ever pull in what you enable. See
[ADR-0020](./adr/0020-editions-and-add-on-modules.md).

## Building the frontend (in your own repo)

Your entire frontend repo is built from scratch - pages, components, admin shell, theme, styling. It consumes the api over HTTP through `@blurifycom/core/react` (typed client, data hooks, auth, realtime transport).

Wrap your root layout with `QueryClientProvider` and `ApiClientProvider` (from `@blurifycom/core/react`):

```tsx
// your-frontend/app/providers.tsx (client component)
import { ApiClientProvider } from '@blurifycom/core/react';
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
`@blurifycom/core/server/orm`, NOT from `drizzle-orm` directly. A direct `drizzle-orm` import resolves to the
consumer's own physical copy; drizzle's protected-member classes then fail nominal type checks
against `DrizzleService.db` (which uses `@blurifycom/core/server`'s copy). `@blurifycom/core/server/orm` re-exports the
framework-free drizzle surface from the single shared instance.

Full hooks guide: `packages/core/src/react/AGENTS.md`.

## Local dev linking to a sibling consumer

Until OSS packages are published to npm, downstream consumers point at this workspace via
`pnpm.overrides` + `link:`. From the consumer's `package.json`:

```jsonc
"pnpm": {
  "overrides": {
    // Everything folded into one package (ADR-0025) - link @blurifycom/core, plus the
    // domain/add-on packages you install, plus the dev configs.
    "@blurifycom/core":           "link:../oss/packages/core",
    "@blurifycom/pam":            "link:../oss/packages/domains/pam",
    "@blurifycom/wallet":         "link:../oss/packages/domains/wallet",
    "@blurifycom/tsconfig":       "link:../oss/packages/config/tsconfig"
  }
}
```

Each linked package's `main` resolves to `./dist/index.js`, so the consumer reads BUILT output.
To keep the link hot during dev, run a watch build here in parallel with the consumer's dev
process:

```bash
pnpm -F @blurifycom/core -F @blurifycom/pam -F @blurifycom/wallet --parallel build --watch
```

Modules under `packages/domains/*` are loaded by the consumer via `extensions.config.ts` paths
pointing at built plugin files - see the load pattern below.

Rejected alternatives: `pnpm link --global` (legacy, leaks state), `yalc` (extra publish step
on every change), `file:` (snapshot copy on install, no live source).

## Consumer load pattern

Consumer `extensions.config.ts` points at the built plugin files inside `@blurifycom/modules`
(`.../packages/domains/dist/<group>/<name>/src/plugin.js`), not source, because tsx in the
consumer's API entry can't reliably resolve the tsconfig (decorator metadata gets dropped).
Always build `@blurifycom/modules` before booting the consumer:

```bash
pnpm -F @blurifycom/modules build
```

For a watch loop during development:

```bash
pnpm -r --filter '@blurifycom/*' --parallel build --watch
```

Paths in the consumer's `extensions.config.ts` resolve relative to that config file's own
directory.

## Tooling notes

- Drizzle tables live in each module's `src/schema/index.ts`. `drizzle.config.ts` (in `@blurifycom/core/server`)
  globs those files; `pnpm regen` runs drizzle-kit to generate migrations. There is no
  schema-merge step.
- All feature modules compile together as the single `@blurifycom/modules` package (`tsc`, rootDir
  `packages/domains`, emitting `dist/<group>/<name>/src/...`).
- `pnpm-workspace.yaml#allowBuilds` (pnpm 11 syntax) replaces the legacy
  `pnpm.onlyBuiltDependencies` in package.json.
- A consumer gets the same AI surface this repo has by running the published `@blurifycom/mcp` server
  against their own repo (see its README) and reading the generated `catalog.json`.
