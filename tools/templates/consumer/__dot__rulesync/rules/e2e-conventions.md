---
root: false
targets:
  - '*'
globs:
  - 'apps/e2e/**'
description: Playwright E2E conventions - dual-mode (USE_MOCKS) specs, fixtures, mocks, page objects.
---

# E2E conventions (`apps/e2e`)

Every spec is written ONCE and runs in two modes, switched by `USE_MOCKS`:

- `USE_MOCKS=true` - CI / pull request: requests fulfilled from `mocks/`, no stack needed, blocks merge.
- unset - scheduled/local run against the real seeded API (`pnpm dev` stack must be up); failures alert, don't block.

## Rules

- Import `test`/`expect` from `fixtures.ts`, NEVER from `@playwright/test` - fixtures add `cleanup()` and shared setup.
- `mockApi(page, routes)` (from `lib/mocks.ts`) registers interceptions only under `USE_MOCKS`; in real mode it's a no-op, so the same assertions exercise the live backend. Never branch test logic on the mode.
- Mocks are typed: fixture shapes in `mocks/<domain>.ts` mirror the response contract - type platform-endpoint fixtures with the `z.infer` contract type from `@openora/*` so a contract change fails typecheck. No loose hand-written JSON.
- Selectors use `data-testid` - kebab-case, domain-prefixed (`chat-message`, `chat-input`). Never assert on CSS classes or component-library structure; shared UI components spread props so `data-testid` passes through.
- Page objects in `pages/<name>.page.ts` are functional factories - no classes, no `this`; locators + actions returned as a plain object.
- Test names are behavioural: "shows masked standings", not "table renders".
- `cleanup(fn)` reverses any real data a test creates (runs in reverse order; no-op under mocks).
- Layout: `tests/<app>/<domain>/<scenario>.spec.ts` (one Playwright project per app, sharing fixtures/mocks/pages; run one with `--project=<app>`), `mocks/<domain>.ts`, `pages/<name>.page.ts`.
