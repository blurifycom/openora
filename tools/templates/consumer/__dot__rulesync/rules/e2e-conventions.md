---
root: false
targets:
  - '*'
globs:
  - 'apps/e2e/**'
description: Playwright E2E conventions - browser specs (dual-mode USE_MOCKS) and the API integration tier.
---

# E2E conventions (`apps/e2e`)

Two kinds of spec live here:

- **Browser specs** (`tests/<app>/**`) - a player or admin journey through the UI. Dual-mode, see below.
- **API specs** (`tests/api/**`) - the `api` Playwright project: no browser, no `page`. Drives the real API over HTTP against real Postgres, with each external vendor replaced by a stub HTTP server the API is pointed at by env. This is the tier that proves an overlay end to end: request -> route -> service -> rows -> webhook -> resulting state. Never runs under `USE_MOCKS` - an intercepted response would erase the integration the spec exists to check.

## Browser specs

Every browser spec is written ONCE and runs in two modes, switched by `USE_MOCKS`:

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

## API specs (`tests/api/**`)

- Use `request` (Playwright's APIRequestContext), never `page`. Assert status, body, and the state a follow-up request reports - not internals.
- A vendor stub is a plain `node:http` server under `apps/e2e/`, modelled on `mock-identity-server.mjs`: it answers only the vendor endpoints the flow reaches and records the calls a spec asserts on. Point the API at it with the vendor's base-URL env var; every vendor adapter must accept one.
- Drive the vendor's inbound side the way the vendor does - post the real webhook shape to the real route with a signature the stub's key material produces. Never call the adapter directly.
- Own your data: create the player the spec needs and reverse it with `cleanup(fn)`. The suite shares one database.
- Layout: `tests/api/<domain>/<scenario>.spec.ts`.
