---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: OSS core is read-only except in an OSS worktree (paired changes); enforced import/module boundaries.
---

# OSS core + import boundaries

## Never patch OSS core in place

`@openora/*` is a dependency - read it for reference, never patch it where it is installed.

- Do NOT edit `node_modules/**` or the main linked OSS checkout (`{{ossDir}}`). The `guard-core` hook denies those writes in every agent tool; don't route around it with `sed`, redirection, or scripts. A patched dependency is lost on reinstall and diverges from the published package, and other sessions build against the main checkout.
- Extend from the OUTSIDE first: overlay plugins, adapter rebindings, UI plugins, config.

## Changing OSS core (paired change)

When the fix or feature can only live in core, change it in core - in a git worktree of `{{ossDir}}`, the one OSS path the hook lets you write. Works the same from any agent tool; `docs/agents/cross-repo.md` lists how each tool is granted access to `{{ossDir}}`.

1. `pnpm oss:worktree <branch>`, with this repo's branch name: the same name in both repos is how skills pair the two requests. It creates or reuses `{{ossDir}}/.worktrees/<branch, / as +>` and installs its dependencies. `--link` also points `pnpm link:oss` at it, so this repo runs against the change.
2. Before the first edit there, read `<worktree>/AGENTS.md`, every `<worktree>/.rulesync/rules/*.md`, and the `<worktree>/docs/standards/` file for the kind of change. Files in the worktree follow the OSS rules; files in this repo follow this repo's rules. On conflict, the file's location decides.
3. The OSS repo's own edit hooks (format, lint, typecheck) do not run from this session. Run `pnpm -C <worktree> verify` before any push.
4. Commit and open the OSS pull request from the worktree, per `<worktree>/docs/standards/skills/delivery.md`, with its own explicit push confirmation. The OSS repo is public: its commits and PR carry the bare ticket key at most - no operator name, no internal URL, no link to this repo's request.
5. Do not link the two requests - the shared branch name pairs them. This repo's request may be read by people outside the team, so it never names or links the OSS repo.
6. Never `git checkout` a branch in the main `{{ossDir}}` checkout. Remove the worktree with `pnpm oss:worktree <branch> --remove` once both requests have merged.

A large core change, or one unrelated to this repo's diff, is better done in a session rooted in the OSS repo - use the `handoff` skill.

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

### Structure checks (`pnpm check:shape`, in repos that ship it)

Runs the checks a dependency graph cannot make, because they are about files that do not exist or edges that do not exist:

- Every module has `index.ts` and `AGENTS.md`.
- The barrel re-exports only; the single side effect it may carry is `import './locales'`.
- Every file under a module's `pages|components|hooks|utils` is reachable from the barrel, and every `packages/ui/src` file from the `{{scope}}/ui` barrel - otherwise it is dead code.

Each app/package owns its own `.dependency-cruiser.cjs` (its own tsconfig for `@/*` alias resolution) built on the shared rule/option helpers in `.dependency-cruiser.shared.cjs`. Where the repo ships `pnpm gen:boundaries-graph`, it renders each package's graph (needs Graphviz).

The shared options keep npm packages in the graph on purpose - a dependency-type rule can only judge a package that is a node - so build output is excluded per workspace path, never as a bare `/dist/`.
