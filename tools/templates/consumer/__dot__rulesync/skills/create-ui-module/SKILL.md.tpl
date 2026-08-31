---
name: create-ui-module
targets: ['*']
description: >
  Create a frontend feature module in apps/backoffice or apps/web following the modular
  architecture in the `frontend-conventions` rule: standard folder shape, co-located
  locales, DI hooks, pure components, barrel entry, route wiring. Use on "create module", "new feature module",
  "add a backoffice/web module", "/create-ui-module <app> <name>".
---

# create-ui-module ({{name}})

Applies once this repo has UI apps (`apps/web` / `apps/backoffice`); an api-only repo has no `src/modules/` to scaffold into.

Scaffold a feature module under `src/modules/<name>/` per the modular architecture in `frontend-conventions` and `docs/standards/frontend.md`. Where the repo ships a module-structure lint rule, it enforces the shape (folder structure, `use-` hook naming, kebab-case files, client-component naming). Copy an existing module in the same app as the reference.

## 1. Resolve input

`<app> <name>` from `$ARGUMENTS` (`backoffice` | `web`, kebab-case name). Ask if missing. Confirm the module doesn't exist and the concern isn't already owned by another module.

## 2. Create the shape

```
src/modules/<name>/
  pages/<name>-page.tsx        page entrypoint(s)
  components/                  presentational only - props in, JSX out
  hooks/use-<x>.ts             ALL logic/queries/mutations; deps passed as parameters
  utils/                       local helpers (only if needed)
  locales/en.json              translation keys
  locales/index.ts             registration (below)
  index.ts                     public barrel - the ONLY entry other code may import
```

`locales/index.ts` pattern (exact):

```ts
import { registerTranslations } from '{{scope}}/ui';
import en from './en.json';

export const locales = { en };
export const ns = registerTranslations('<name>', locales);
```

Components use `useTranslation(ns)`; no hardcoded copy. Non-`en` files mirror `en.json` keys exactly.

## 3. Wire the route

- backoffice: `src/routes/_authed/<name>.tsx` -> `createFileRoute` with `component` imported from `@/modules/<name>`; mirror a sibling route file.
- web: the App Router page under `app/(shell)/<name>/` imports from `@/modules/<name>`; client components get `'use client'` line 1 + `.client.tsx` suffix.

## 4. Non-negotiables

- No cross-module imports - cross-module effects go through query cache invalidation, never a direct import.
- Outside code imports ONLY the barrel via `@/modules/<name>`; inside the module use relative paths.
- Hooks take their clients (oRPC/API) as parameters via a `use-<domain>-client-deps.ts` hook so they're testable without global mocks.
- Follow the `frontend-conventions` rule + `docs/standards/frontend.md` (daisyUI, theme tokens, hoisted `styles` const, React Compiler - no manual memo).

## 5. Verify

`/check` green (any structure lint runs inside `pnpm check:lint`); route renders (`pnpm dev`). Hand to `review` before an MR.
