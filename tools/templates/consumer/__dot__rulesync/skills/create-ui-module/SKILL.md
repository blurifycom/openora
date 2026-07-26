---
name: create-ui-module
targets: ['*']
description: >
  Create a frontend feature module in apps/backoffice or apps/web following ADR-0001's
  modular architecture: standard folder shape, co-located locales, DI hooks, pure
  components, barrel entry, route wiring. Use on "create module", "new feature module",
  "add a backoffice/web module", "/create-ui-module <app> <name>".
---

# create-ui-module (consumer)

Scaffold a feature module under `src/modules/<name>/` per ADR-0001 (`docs/adr/0001-modular-architecture.md`). The shape is lint-enforced (`tools/oxlint-module-structure.mjs`: folder structure, `use-` hook naming, kebab-case files, client-component naming). Copy an existing module as the reference - `apps/backoffice/src/modules/roles/` is canonical.

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
import { registerTranslations } from '@<scope>/ui';
import en from './en.json';

export const locales = { en };
export const ns = registerTranslations('<name>', locales);
```

Components use `useTranslation(ns)`; no hardcoded copy. Non-`en` files mirror `en.json` keys exactly.

## 3. Wire the route

- backoffice: `src/routes/_authed/<name>.tsx` -> `createFileRoute` with `component` imported from `@/modules/<name>` (see `src/routes/_authed/roles.tsx`).
- web: the App Router page under `app/(shell)/<name>/` imports from `@/modules/<name>`; client components get `'use client'` line 1 + `.client.tsx` suffix.

## 4. Non-negotiables

- No cross-module imports - cross-module effects go through query cache invalidation, never a direct import.
- Outside code imports ONLY the barrel via `@/modules/<name>`; inside the module use relative paths.
- Hooks take their clients (oRPC/API) as parameters (see `roles/hooks/use-iam-client-deps.ts`) so they're testable without global mocks.
- Follow the conventions rule's Frontend + Modular architecture sections (daisyUI, theme tokens, hoisted `styles` const, React Compiler - no manual memo).

## 5. Verify

`/check` green (the structure lint runs inside `pnpm lint`); route renders (`pnpm dev`). Hand to `review` before an MR.
