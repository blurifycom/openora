---
root: false
targets:
  - '*'
globs:
  - 'apps/e2e/**'
description: Playwright E2E conventions - specs run against the real stack; mocking is a narrow, justified exception.
---

# E2E conventions (`apps/e2e`)

Two kinds of spec live here:

- **Browser specs** (`tests/<app>/**`) - a player or admin journey through the UI.
- **API specs** (`tests/api/**`) - the `api` Playwright project: no browser, no `page`. Drives the real API over HTTP against real Postgres, with each external vendor replaced by a stub HTTP server the API is pointed at by env. This is the tier that proves an overlay end to end: request -> route -> service -> rows -> webhook -> resulting state. `USE_MOCKS` does not apply here at all.

## Real stack by default

Every spec runs against the real seeded stack - API, Postgres, and the apps under test - and that
run is what blocks merge. A test that never executes the backend cannot tell you the backend works.

`USE_MOCKS=true` intercepts responses in the browser and exists only for a state you cannot produce
for real: a third-party widget or redirect you are not allowed to run in CI. It is an exception you
justify per spec, never the mode a suite is written for. Anything reachable by seeding data or by
scripting a vendor stub is NOT such a state - script the stub instead, and prefer the API tier when
the behaviour under test is the backend's.

Existing mocked specs are converted as they are touched; delete the fixture with the last spec that
used it.

## Rules

- Import `test`/`expect` from `fixtures.ts`, NEVER from `@playwright/test` - fixtures add `cleanup()` and shared setup.
- Set up state through the product: seed data or drive the API, so the spec exercises the same path a player would. `mockApi(page, routes)` (from `lib/mocks.ts`) is the escape hatch above - reach for it only after the real setup is genuinely impossible, and never branch test logic on the mode.
- A mock that stays is typed: fixture shapes in `mocks/<domain>.ts` mirror the response contract - type platform-endpoint fixtures with the `z.infer` contract type from `@openora/*` so a contract change fails typecheck. No loose hand-written JSON.
- Selectors use `data-testid` - kebab-case, domain-prefixed (`chat-message`, `chat-input`). Never assert on CSS classes or component-library structure; shared UI components spread props so `data-testid` passes through.
- Page objects in `pages/<name>.page.ts` are functional factories - no classes, no `this`; locators + actions returned as a plain object.
- Test names are behavioural: "shows masked standings", not "table renders".
- `cleanup(fn)` reverses any data a test creates (runs in reverse order) - the suite shares one database, so a spec that leaks rows breaks the next one.
- Layout: `tests/<app>/<domain>/<scenario>.spec.ts` (one Playwright project per app, sharing fixtures/mocks/pages; run one with `--project=<app>`), `mocks/<domain>.ts`, `pages/<name>.page.ts`.

## API specs (`tests/api/**`)

- Use `request` (Playwright's APIRequestContext), never `page`. Assert status, body, and the state a follow-up request reports - not internals.
- A vendor stub is a plain `node:http` server under `apps/e2e/`, modelled on `mock-identity-server.mjs`: it answers only the vendor endpoints the flow reaches and records the calls a spec asserts on. Point the API at it with the vendor's base-URL env var; every vendor adapter must accept one.
- Drive the vendor's inbound side the way the vendor does - post the real webhook shape to the real route with a signature the stub's key material produces. Never call the adapter directly.
- Own your data: create the player the spec needs and reverse it with `cleanup(fn)`. The suite shares one database.
- Layout: `tests/api/<domain>/<scenario>.spec.ts`.
