---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: OSS core is read-only; enforced import/module boundaries.
---

# OSS core + import boundaries

## Never modify OSS core

`@openora/*` is a third-party dependency - read it for reference, never write to it.

- Do NOT edit `node_modules/**` or the linked OSS checkout (`{{ossDir}}`). Those paths are write-denied in `.claude/settings.json`; don't route around it with `sed`, redirection, or scripts. A patched dependency is lost on reinstall and diverges from the published package.
- Extend from the OUTSIDE only: overlay plugins, adapter rebindings, UI plugins, config.
- If something can only be fixed in core, STOP and report it upstream (problem, expected behavior, likely location).

## Import boundaries (enforced)

Enforced by `pnpm check:lint` (oxlint, per-edit), the pre-commit hook, CI, and the agent PostToolUse hook - plus `pnpm check:boundaries` (dependency-cruiser, one graph per app/package via turbo) and `pnpm check:shape` in repos that ship them. Fix the import, never work around a violation.

### Across packages

- No deep OSS imports: `@openora/*/src/*` or `/dist/*` - import only the package entrypoint (oxlint owns this one; every published entrypoint resolves into `dist/`, so the boundary graph cannot tell the two apart).
- No deep `{{scope}}/ui` imports - only the barrel.
- No app-to-app imports (`apps/web` <-> `apps/backoffice` <-> `apps/api`) - extract shared code to `packages/*`. Never reach across with a relative `../../apps/` path either.
- No deep workspace-package imports - only the index entrypoint.
- No import cycles.
- A shared package (`packages/*`) must not import from an app.
- `{{scope}}/ui` is renderer- and router-agnostic: no `next`, no router package. Take the capability through an injected adapter (see `navigation.tsx`).
- No Node builtins in browser code (the Next instrumentation/proxy entries and `src/lib/api-server.*` are the declared exceptions).

### Inside an app (ADR-0001)

- No cross-module imports; a module is reached only through its barrel `index.ts`.
- Layering inside a module: `pages/` is the leaf - `components/`, `hooks/`, `utils/` must not import it; `utils/` must not import `components/`, `hooks/` or `pages/`.
- A file inside a module must not import its own barrel.
- The shared kernel (`src/lib`, `src/hooks`, `src/utils`, `src/components`) must not import a feature module - dependencies point inwards.
- Routes are leaves: nothing may import `src/app/**` (web) or `src/routes/**` / `routeTree.gen.ts` (backoffice, except `main.tsx`).
- Transport clients (`@orpc/client`, `@orpc/openapi-client`, `@orpc/tanstack-query`) are constructed in `src/lib/` only.
- A `'use client'` file must not import server-only code (`next/headers`, `src/lib/api-server.*`, `*.server.ts`).

### Dependency manifest hygiene

- Every import resolves; every npm package used is declared in that package's own `package.json`; no package sits in two dependency sections (a library's devDependency + peerDependency pair is the exception).
- Production code imports no devDependency and no test/mock/fixture file.

### Structure checks (`pnpm check:shape`)

Runs the checks a dependency graph cannot make, because they are about files that do not exist or edges that do not exist:

- Every module has `index.ts` and `AGENTS.md`.
- The barrel re-exports only; the single side effect it may carry is `import './locales'`.
- Every file under a module's `pages|components|hooks|utils` is reachable from the barrel, and every `packages/ui/src` file from the `{{scope}}/ui` barrel - otherwise it is dead code.

Each app/package owns its own `.dependency-cruiser.cjs` (its own tsconfig for `@/*` alias resolution) built on the shared rule/option helpers in `.dependency-cruiser.shared.cjs`. `pnpm gen:boundaries-graph` renders each package's graph (needs Graphviz).

The shared options keep npm packages in the graph on purpose - a dependency-type rule can only judge a package that is a node - so build output is excluded per workspace path, never as a bare `/dist/`.
