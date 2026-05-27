# Consuming the platform from a downstream repo

How a downstream operator (eg Consumer) builds their own igaming on top of `@oss/*` without
forking core. The root `AGENTS.md` links here; this is the detail an agent loads only when
actually wiring a consumer.

See also [`examples/minimal-igaming/`](../examples/minimal-igaming/) for a runnable template and
[`CATALOG.md`](./CATALOG.md) for the machine-readable surface (routes, schemas, adapter tokens,
slots, events, config schema) an agent reads instead of grepping `node_modules`.

## Fastest path: scaffold the repo

From this OSS checkout, generate a full consumer turborepo wired to link at it:

```bash
pnpm create:app ../my-igaming --name my-igaming
cd ../my-igaming
pnpm install
pnpm setup:mcp          # trust the MCP server + install the /start onboarding flow
pnpm build:oss          # build the linked @oss/* packages once
cp .env.example .env     # set DATABASE_URL + AUTH_SECRET
pnpm db:migrate          # apply the OSS schema
pnpm dev                 # api :3001, web :3000, backoffice :3002
```

After install, run `pnpm setup:mcp` and then `/start` in Claude Code: it asks what you want to
build, calls the `enhance-intent` MCP tool to turn the ask into a grounded spec, and drives the
matching scaffold flow. See [mcp-setup.md](./mcp-setup.md#zero-config-setup-pnpm-setupmcp).

This emits everything the sections below describe by hand: `apps/api` (thin `createApp` entry +
`extensions.config.ts`), `apps/web` + `apps/backoffice` (mounting react-sdk pages with the dedup
config), root `pnpm.overrides` linking every `@oss/*`, `.mcp.json`, the three consumer AI agents,
and `turbo/generators/` (`pnpm gen plugin|adapter|page`). The CLI lives at
`tools/create-igaming-app.ts`; the shared base tree at `tools/templates/consumer/` and the
per-app trees at `tools/templates/variants/`. Read on to understand what it generated and how to
extend it.

### Choosing the frontend frameworks

The player and admin apps each ship in two flavours, selected by flag:

| Flag | Values | Default | Emits |
|---|---|---|---|
| `--web` | `next`, `tanstack` | `next` | `apps/web` as a Next 16 player app, or a TanStack Start (Vite + SSR) player app |
| `--backoffice` | `next`, `vite` | `vite` | `apps/backoffice` as a Next 16 admin app, or a Vite + TanStack Router client-only SPA |

```bash
pnpm create:app ../poc --name poc --web=tanstack --backoffice=vite
```

Defaults keep full backward compatibility for the player app (`--web=next`). The admin default is
the Vite SPA (`--backoffice=vite`); pass `--backoffice=next` for the original Next admin app. Every
variant uses the same react/react-dom/@tanstack/react-query dedup (Vite `resolve.dedupe` + alias,
the Vite equivalent of the Next `next.config.ts` alias - see ADR-0005) so the linked `@oss/*` and
the app share a single physical React copy. The TanStack Start player routes fetch via the
`@oss/react-sdk/server` loaders (`fetchLobbyData`, `fetchSportsbookData`), forwarding the request
cookies; the wallet renders client-only.

## API entrypoint

A downstream consumer imports `@oss/api-runtime` and creates an API instance:

```typescript
// consumer/apps/api/src/main.ts
import { createApp } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { extensions } from './extensions.config.js'; // their own plugin list

const { listen, emitOpenApiSpec } = await createApp({
  plugins: extensions,
  contract, // pass a composed contract if extended
  port: 3001,
  cors: { origins: ['https://consumer.com'] },
  openapi: { info: { title: 'Consumer API', version: '1.0.0' } },
});

await listen();
await emitOpenApiSpec();
```

The OSS `apps/api` is itself a thin consumer of `createApp` and serves as the reference.
Downstream consumers do NOT fork `apps/api` - they create their own thin entrypoint and bring
their own `extensions.config.ts`.

For the UI side, downstream consumers swap `@oss/ui-provider-shadcn` for their own adapter
package via the `UIProvider` React Context at the Next.js layout layer. No factory needed.

## Mounting the backoffice in a downstream Next app

`@oss/react-sdk` ships the typed client, hooks, UI/theme context, admin shell, and page bodies.
Consumers mount the pages in their own `app/` directory. The page bodies are interactive client
components; the route files stay server components.

```tsx
// consumer/apps/web/app/admin/(authed)/page.tsx (server component)
import { DashboardPage } from '@oss/react-sdk';
export default function Page() {
  return <DashboardPage />;
}
```

Wrap the consumer's root layout with `QueryClientProvider`, `ApiClientProvider`, and
`UIProvider` (plus optionally `ThemeProvider` for theming and `UIPluginProvider` for plugin
extensions). All except `QueryClientProvider` come from `@oss/react-sdk`:

```tsx
// consumer/apps/web/app/providers.tsx (client component)
import { ApiClientProvider, UIProvider, ThemeProvider, UIPluginProvider } from '@oss/react-sdk';
import { shadcnProvider } from '@oss/ui-provider-shadcn';
import '@oss/react-sdk/styles.css';

<ApiClientProvider client={{ baseUrl }}>
  <ThemeProvider preset="editorialBrass">
    <UIProvider value={shadcnProvider}>
      <UIPluginProvider plugins={[vipTiersUI]}>{children}</UIPluginProvider>
    </UIProvider>
  </ThemeProvider>
</ApiClientProvider>;
```

Per-tenant theming reduces to passing a `Partial<Theme>` from a DB row to
`<ThemeProvider theme={...}>`. The package exports `Theme`, `defaultTheme`, and `themePresets`.
UI extensions (nav items, table columns, dashboard tiles, etc) come from `defineUIPlugin`
contributions passed to `UIPluginProvider` - see ADR-0006.

### Using the DaisyUI adapter (Consumer's choice)

shadcn is the OSS default (headless HTML + data-attrs). To brand the whole tree with DaisyUI,
swap one import - `daisyuiProvider` satisfies the same `@oss/ui-provider-contract`, so no page
bodies change:

```tsx
import { UIProvider } from '@oss/react-sdk';
import { daisyuiProvider } from '@oss/ui-provider-daisyui';

<UIProvider value={daisyuiProvider}>{children}</UIProvider>;
```

DaisyUI emits semantic Tailwind classes (`btn`, `card`, `modal`, ...) and ships no styles itself,
so the consuming app enables Tailwind + the DaisyUI plugin in its own CSS. For Tailwind v4:

```css
/* the app's global stylesheet, imported alongside @oss/react-sdk/styles.css */
@import "tailwindcss";
@plugin "daisyui";
```

The react-sdk's `styles.css` supplies structural/layout classes (`player-card`, `page-header`);
DaisyUI supplies the component look. They target different elements and coexist.

Both adapters are framework-agnostic React with no browser globals at module scope, so they render
unchanged under Next RSC/SSR, TanStack Start, or a Vite SPA. The provider is passed inside a client
component (`providers.tsx`), where `useToast`'s state lives.

Cross-workspace `link:` requires a dedup alias in the consumer's `next.config.ts` for `react`,
`react-dom`, and `@tanstack/react-query` (single physical path). See ADR-0005.

For the same reason, a linked consumer's own Drizzle code (tables + operators) must import from
`@oss/db/orm`, NOT from `drizzle-orm` directly. A direct `drizzle-orm` import resolves to the
consumer's own physical copy; drizzle's protected-member classes then fail nominal type checks
against `DrizzleService.db` (which uses `@oss/db`'s copy). `@oss/db/orm` re-exports the
framework-free drizzle surface from the single shared instance.

Full UI guide: `packages/sdks/react-sdk/AGENTS.md`.

## Local dev linking to a sibling consumer (eg `../consumer/`)

Until OSS packages are published to npm, downstream consumers point at this workspace via
`pnpm.overrides` + `link:`. From the consumer's `package.json`:

```jsonc
"pnpm": {
  "overrides": {
    "@oss/api-runtime":    "link:../igaming-oss/packages/platform/api-runtime",
    "@oss/plugin-host":    "link:../igaming-oss/packages/platform/plugin-host",
    "@oss/core":           "link:../igaming-oss/packages/platform/core",
    "@oss/db":             "link:../igaming-oss/packages/platform/db",
    "@oss/orpc-contract":  "link:../igaming-oss/packages/contracts/orpc-contract",
    "@oss/shared-schemas": "link:../igaming-oss/packages/contracts/shared-schemas",
    "@oss/tsconfig":       "link:../igaming-oss/packages/config/tsconfig"
  }
}
```

Each linked package's `main` resolves to `./dist/index.js`, so the consumer reads BUILT output.
To keep the link hot during dev, run a watch build here in parallel with the consumer's dev
process:

```bash
pnpm -F @oss/api-runtime -F @oss/core -F @oss/db \
       -F @oss/plugin-host -F @oss/orpc-contract -F @oss/shared-schemas \
       --parallel build --watch
```

Modules under `packages/modules/*` are loaded by the consumer via `extensions.config.ts` paths
pointing at built plugin files - see the load pattern below.

Rejected alternatives: `pnpm link --global` (legacy, leaks state), `yalc` (extra publish step
on every change), `file:` (snapshot copy on install, no live source).

## Consumer load pattern

Consumer `extensions.config.ts` points at the built plugin files inside `@oss/modules`
(`.../packages/modules/dist/<group>/<name>/src/plugin.js`), not source, because tsx in the
consumer's API entry can't reliably resolve the tsconfig (decorator metadata gets dropped).
Always build `@oss/modules` before booting the consumer:

```bash
pnpm -F @oss/modules build
```

For a watch loop during development:

```bash
pnpm -r --filter '@oss/*' --parallel build --watch
```

Paths in the consumer's `extensions.config.ts` resolve relative to that config file's own
directory.

## Tooling notes

- Drizzle tables live in each module's `src/schema/index.ts`. `drizzle.config.ts` (in `@oss/db`)
  globs those files; `pnpm regen` runs drizzle-kit to generate migrations. There is no
  schema-merge step.
- All feature modules compile together as the single `@oss/modules` package (`tsc`, rootDir
  `packages/modules`, emitting `dist/<group>/<name>/src/...`).
- `pnpm-workspace.yaml#allowBuilds` (pnpm 11 syntax) replaces the legacy
  `pnpm.onlyBuiltDependencies` in package.json.
- A consumer gets the same AI surface this repo has by running the published `@oss/mcp` server
  against their own repo (see its README) and reading the generated `CATALOG.md`.
