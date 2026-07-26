---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: Engineering code conventions (TS, frontend, testing, git) - apply all of these to every change.
---

# Engineering conventions

Portable code standard for this repo.
The enforced import graph lives in `oss-boundaries`; SQL rules in `db-conventions`; Playwright rules in `e2e-conventions`.

## Philosophy

- Functional and declarative: pure functions, immutable data, composition. No stateful classes, no imperative accumulation loops.
- Explicit over magic: no decorators, no auto-discovery, no reflection. Every wiring point is a greppable typed call (`ctx.provide(TOKEN, factory)`).
- Self-documenting: clear names beat comments (`percentChange`, not `d` + a comment).
- YAGNI then DRY: don't build for imagined futures; abstract on the third occurrence, not the first.
- Boring and consistent: match the surrounding code's idiom, naming, and density.

## Naming

- Files `kebab-case.ts`, one concept per file, filename names the concept (`wallet.service.ts`; never `helpers.ts`, `utils2.ts`).
- Types `PascalCase`; values/functions `camelCase`; true global constants `SCREAMING_SNAKE_CASE`.
- Zod schemas `<Name>Schema`; the inferred type is the bare `<Name>`.
- Booleans read as predicates (`isActive`, `canEdit`); IO functions as verbs (`fetchInvoice`); names carry units/intent (`delayMs`, `maxRetries`).
- Money is a decimal string plus a `currency` field alongside it - `amount`, `balance`, `threshold`, never `amountCents`.

## Types

- One source of truth per shape - infer, never hand-write a type that already exists: `z.infer<typeof UserSchema>`, `typeof users.$inferSelect`, `Omit<User, 'id'>`.
- Schema-first at every boundary (HTTP, config, env, messages, events): validate once at the edge, trust the type after. oRPC + Zod does this for routes; do the same elsewhere.
- Never re-infer a schema you imported - the owning contract exports the type once; import it.
- No `any` outside tests - `unknown` + narrowing.
- No `as` casts to silence the compiler - fix the root cause (`as const` is fine).
- Never `!` non-null assertions - narrow explicitly, or restructure so the value is provably present (carry it on the object instead of re-looking it up).
- Under `noUncheckedIndexedAccess`: `.at()`, destructure-with-default (`const [first = ''] = parts`), or an explicit guard - never `arr[i]!`.
- `type` over `interface` (lint-enforced).
- Type entity ids through their owning type (`playerId: Player['id']`), never a bare `string`.
- Derive related schemas with `.pick()/.omit()/.partial()/.extend()/.merge()` - never re-type fields.
- Enum-like value sets are a values + schema + type triple declared once on the contract surface: `X_STATUSES = [...] as const` -> `XStatusSchema = z.enum(X_STATUSES)` -> inferred `XStatus`. Never a TS `enum`, never a second hand-typed copy - import the one from `@openora/*`.
- Make illegal states unrepresentable - discriminated unions (`{ status: 'ok'; data } | { status: 'error'; error }`) over optional-flag soup.

## Functions and modules

- Pure functions with dependencies passed in as arguments; side effects only at the edges (services, adapters, plugins, handlers) - never in helpers.
- Immutability: derive new objects (`{ ...user, roles: [...] }`), don't mutate.
- Construct objects by spread + override, never field-by-field hand-copy. Keep fields explicit only for order-sensitive serialization, when the target must not receive some source fields, or when null-vs-undefined matters at a boundary.
- A `class` is only a thin dependency-holding shell at a composition root; methods delegate to pure functions. No inheritance for reuse, no decorators - compose.
- Short, single-purpose functions - if you'd write `// step 2` inside one, extract it.
- Guard clauses first, main path last.
- More than 3 parameters -> a single named-object param.
- Don't annotate a return type TypeScript can infer. Annotate only when: inference can't (recursion), you deliberately widen/narrow, or it's the exported public API of a shared `packages/*` module - there the explicit type IS the contract. Argument types always stay explicit.
- Named exports only - no default exports (exceptions: `*.config.*` files, `plugin.ts` whose loader reads `mod.default`, and Next.js App Router files; lint-enforced).

## Comments

- Comment WHY, never WHAT: hidden constraint, invariant, bug workaround (link it), trade-off. If a block needs a comment to be understood, rename/extract instead.
- No section-divider comments (`// ---`, `// ===`).
- Every JSDoc is multi-line, always - `/**`, the text, and `*/` each on their own line. A single-line `/** ... */` is never allowed, even for one sentence. Add one only on an independent function/class (not a React component or hook) that is >~15 lines or has non-obvious params. One sentence; document the surprising contract, not the name.
- Never JSDoc a React component or hook - a genuinely surprising note goes on the specific prop/param type, or an inline comment at the call site.
- Deferred work: `// TODO:` with the concrete follow-up, never a bare TODO.
- Placeholder/sample data and stubs: greppable `// mock:` comment so throwaway code stays findable.

## Frontend (any `apps/*` UI app and your shared UI package)

Applies when this repo hosts UI apps; a headless api-only consumer can skip this section.

- React Compiler is ON. Never hand-write `useMemo`/`useCallback`/`React.memo` - a compiler bail is a Rules-of-React violation to fix. Exception: your shared UI package is consumed pre-built, so hand-write stability there when it's part of a hook's contract (same reason `@openora/core/react` does).
- Pick ONE component library and use its classes customized via utility classes + theme tokens. Don't hand-roll what the library provides.
- Never hand-write component CSS selectors (`.btn-*{}`, `.table th{}`). A per-app `styles.css` holds only the theme plus custom properties for raw values with no token; every other style is a utility class on the element.
- App-specific looks live in that app's `styles.css`; shared UI components stay visually neutral.
- No hardcoded user-facing copy - every label goes through `t()` with a key in the module's `locales/`. Pattern: `locales/index.ts` exports `export const ns = registerTranslations('<module>', locales)`; components use `useTranslation(ns)`. Non-`en` files mirror `en.json` keys exactly.
- Theme tokens and CSS variables are declared once in the shared UI package - style with semantic tokens (`bg-base-100`, `text-base-content`, `btn-primary`), never inline raw hex. A design color with no token: add it to BOTH dark and light theme blocks. A new token without a design source: ask the user first.
- Hoist long class strings into a module-scope `const styles = { ... } as const` keyed by role - never inline long strings in JSX; merge with `cn()`.
- Extract a repeated utility-class recipe into a shared component or constant on the third occurrence.
- Import helpers like `cn()` from the shared UI package barrel - never deep-import.
- Server state is not client state - key/cache/invalidate via the query lib, never `useEffect(fetch)`, never shadowed in ad-hoc caches.

## Modular architecture (every app)

- Feature modules live in `src/modules/<m>/` with the same internal folders: `pages/`, `components/`, `hooks/`, `utils/`, `locales/`, and a public barrel `index.ts`.
- App-level (non-module) code splits the same way: `src/lib/` holds stateful/integration code (API clients, SDK wrappers, config); `src/utils/` holds pure stateless helpers (formatters, converters).
- No cross-module imports, ever. Cross-module communication is query invalidation or a domain event, never a direct import.
- Outer composition code (`src/app/`, `src/routes/`, `extensions.config.ts`) imports modules only through their barrel; deep-importing internals is forbidden. Files inside a module use relative paths to siblings only, never `../../` out of the module.
- Components in `components/` and `pages/` are presentation-only: props in, JSX out - no fetching, no side effects. Business logic, queries, and mutations live in `hooks/`, which accept external dependencies (oRPC calls, API clients) as parameters.
- Next.js client components: `'use client'` on line 1 + `.client.tsx` suffix; server components are the default (no marker). All-client apps (Vite/TanStack) use no suffix.
- One concept per file, exported name matches the kebab-case filename; split hooks and components into separate files.

## Package structure (`packages/*` and overlay packages)

- One package = one concern, named `@<scope>/<kebab>`, with an explicit `exports` map. The entrypoint IS the public API; everything else is internal and off-limits to consumers (`oss-boundaries`).
- Overlay/add-on packages mirror the platform module shape: `contract/`, `schema/`, `service/`, `router/`, `adapters/`, `__tests__/`, plus `plugin.ts` at the root as the single wiring point.
- Each overlay owns its `drizzle.config.ts` and its own migration history - never share one migration folder across packages.
- Pin exact dependency versions in every package; a package never depends on an app.

## Errors

- Fail fast at boundaries with typed errors (`CreateOrderSchema.parse(raw)` throws early).
- No silent catches - log with context and rethrow.
- Typed, named error classes via the shared factories (`makeNotFoundError`/`makeOwnershipError`/`makeConflictError`); the router's `mapErrors` keys off the exported class.
- `ORPCError.message` is an English fallback for logs, not player-facing copy - UI copy keys off `.code` plus typed `.data` fields.
- Money/critical paths are transactional AND idempotent: a DB guard inside the transaction, not just an `idempotencyKey` (delivery is at-least-once).

## Testing

- Co-locate as `src/__tests__/<name>.test.ts` (Vitest); service tests use a vi-mocked Drizzle.
- Test behavior, not implementation - tests must survive a safe refactor (assert outputs, not private caches).
- Cover new logic as part of the same change: unit tests for pure functions, authz negatives included.
- Deterministic and isolated: no shared mutable state, no real network, seedable data.

## Dependencies

- Pin exact versions - no `^`/`~`.
- No inline `fetch`/`axios` in module code - third-party integrations are ports + adapters bound at the composition root (`ctx.provide(KYC_ADAPTER, ...)`).
- Add a dependency deliberately - std lib or a few lines often beat a tree.

## Git and delivery

- Conventional commits, enforced by commitlint (husky + CI): `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `perf`. E.g. `feat(wallet): atomic debit command port`.
- Subject starts lowercase, acronyms included (`feat(pam): kyc status filter`). This applies to the PR title too - squash merges derive the commit message from it.
- One PR = one concern. Stage files explicitly; never `git add -A` when foreign changes are in the tree.
- Green before review: typecheck + lint + unit tests pass; `pnpm verify` is the full gate (adds format:check + boundaries + build).
- Branch off `dev`; never commit directly to a shared branch; never push without an explicit per-action "yes push".
- PR description carries intent: what / why / acceptance criteria / ticket link. No secrets, internal hostnames, or PII - it is the public record.

## Enforcement

- `pnpm check:types` + `pnpm check:lint` (oxlint) + `pnpm test:unit` is the fast gate; `pnpm check:boundaries` (dependency-cruiser) is the whole-graph boundary/cycle check, also run by the pre-commit hook and CI.
- oxlint extends the platform's shared config (`./node_modules/@openora/core/oxlint/oxlintrc.json`) - add local rules on top, never fork it.
- Don't work around a lint/boundary violation - fix the import.
- Agent rules are generated from `.rulesync/` via `pnpm gen:agents` - never hand-edit a generated file.
