# Frontend conventions

React/UI rules for this repo's `apps/*` UI apps and shared UI package. Read this before touching
`apps/web/**`, `apps/backoffice/**`, or `packages/ui/**`. Not applicable if this repo is
headless/api-only - delete this file and its row in `conventions`'s routing table in that case.

## Component library and styling

- React Compiler is ON. Never hand-write `useMemo`/`useCallback`/`React.memo` - a compiler bail is
  a Rules-of-React violation to fix. Exception: your shared UI package is consumed pre-built, so
  hand-write stability there when it's part of a hook's contract (same reason `@openora/core/react`
  does).
- Pick ONE component library and use its classes customized via utility classes + theme tokens.
  Don't hand-roll what the library provides.
- Never hand-write component CSS selectors (`.btn-*{}`, `.table th{}`). A per-app `styles.css`
  holds only the theme plus custom properties for raw values with no token; every other style is
  a utility class on the element.
- App-specific looks live in that app's `styles.css`; shared UI components stay visually neutral.
- No hardcoded user-facing copy - every label goes through `t()` with a key in the module's
  `locales/`. Pattern: `locales/index.ts` exports `export const ns = registerTranslations('<module>',
locales)`; components use `useTranslation(ns)`. Non-`en` files mirror `en.json` keys exactly.
- Theme tokens and CSS variables are declared once in the shared UI package - style with semantic
  tokens (`bg-base-100`, `text-base-content`, `btn-primary`), never inline raw hex. A design color
  with no token: add it to BOTH dark and light theme blocks. A new token without a design source:
  ask the user first.
- Hoist long class strings into a module-scope `const styles = { ... } as const` keyed by role -
  never inline long strings in JSX; merge with `cn()`.
- Extract a repeated utility-class recipe into a shared component or constant on the third
  occurrence.
- Import helpers like `cn()` from the shared UI package barrel - never deep-import.
- Server state is not client state - key/cache/invalidate via the query lib, never
  `useEffect(fetch)`, never shadowed in ad-hoc caches.
- No label or text is allowed to overflow its container - never leave text unconstrained by
  default. Pick per element, based on whether the full text is load-bearing: `truncate` + a
  `title` attribute holding the full string when a single line is the right shape and hiding the
  tail is acceptable (a table cell, a narrow badge); `line-clamp-N` + a reserved `min-h-[NlH]` when
  several lines are the right shape or the content differs in length across siblings that must
  stay visually aligned (a KPI tile label, a card title) - the reserved height keeps every sibling
  the same height whether or not its text actually wraps. A tooltip/popover with the full text is
  the fallback only when neither fits the UX.

## Modular architecture (every app)

- Feature modules live in `src/modules/<m>/` with the same internal folders: `pages/`,
  `components/`, `hooks/`, `utils/`, `locales/`, and a public barrel `index.ts`.
- App-level (non-module) code splits the same way: `src/lib/` holds stateful/integration code
  (API clients, SDK wrappers, config); `src/utils/` holds pure stateless helpers (formatters,
  converters).
- No cross-module imports, ever. Cross-module communication is query invalidation or a domain
  event, never a direct import.
- Outer composition code (`src/app/`, `src/routes/`, `extensions.config.ts`) imports modules only
  through their barrel; deep-importing internals is forbidden. Files inside a module use relative
  paths to siblings only, never `../../` out of the module.
- Components in `components/` and `pages/` are presentation-only: props in, JSX out - no
  fetching, no side effects. Business logic, queries, and mutations live in `hooks/`, which accept
  external dependencies (oRPC calls, API clients) as parameters.
- Next.js client components: `'use client'` on line 1 + `.client.tsx` suffix; server components
  are the default (no marker). All-client apps (Vite/TanStack) use no suffix.
- One concept per file, exported name matches the kebab-case filename; split hooks and components
  into separate files.
