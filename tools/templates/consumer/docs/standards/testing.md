# Testing

Read this before adding or restructuring a test.

## When a test is written

A feature PR carries **no tests** - no Playwright spec, no integration test, no unit test. It
carries the change and the manual verification pass that proves the change works.

Before the PR opens:

1. Drive the change against the running stack. Reach for the **Playwright CLI** first
   (`npx playwright screenshot <url> <file>`, or a throwaway spec that clicks through the flow) -
   it costs a fraction of the tokens a browser MCP does. Use a browser MCP only for a live console
   or network read the CLI cannot give you.
2. Capture the evidence: one screenshot per changed screen, and the before/after pair when you
   fixed something. An API-only change attaches the request/response trace instead.
3. Attach that evidence **to the PR description**, not only to your report - a reviewer confirms a
   change by looking at it, because there is no spec to read.
4. End the description with a **"Tests to add"** list built from what you just exercised: one line
   per test the change deserves, naming its tier (unit / API E2E / browser E2E) and the path it
   would live at. Include the hostile paths and the authz negatives. Prose only - never test code.

Every one of those tests lands afterwards, in its own **stacked test PR** branched off the feature
branch: it targets the feature branch while that is open, and the integration branch once it has
merged, titled `test(<TICKET>): tests for <feature>`. Write them from what the manual pass actually
exercised.

A missing test is therefore never a review blocker on a feature PR. Write tests when you are
explicitly asked for that stacked PR - and then the tier table below says where each one goes.

## Pick the tier

Pick the OUTERMOST tier that can reach the behaviour - a test earns its keep by running real code,
not by being cheap.

| What you changed                                              | Tier                                          |
| ------------------------------------------------------------- | --------------------------------------------- |
| A screen, a form, a player/admin journey                      | Browser E2E (`apps/e2e/tests/<app>/**`)       |
| An API route, an overlay, a vendor adapter, anything with SQL | API E2E (`apps/e2e/tests/api/**`)             |
| A pure function - parser, resolver, mapper, money calculation | Unit (`src/__tests__/<name>.test.ts`, Vitest) |

The API tier drives the real API over HTTP against real Postgres, with each external vendor
replaced by a stub HTTP server the API is pointed at by env. It is the default tier for
`apps/api/src/extensions/**`: an overlay is wiring, and wiring is exactly what a unit test skips.

## What is real, what is doubled

- **Anything that touches the database is tested against real Postgres.** Never fake a query
  builder: a stubbed chain proves a call order, not a result, so it misses the regressions that
  matter - a unique-index conflict, a wrong `where`, a lost race, a rollback that never happened.
- **External vendors are stubbed at their HTTP boundary** (a `node:http` stand-in the API's
  base-URL env var points at), never by mocking our own adapter - a mocked adapter skips exactly
  the wiring the test exists to check. Every vendor adapter therefore accepts a base-URL override.
- **A spy assertion is never the point of a test.** `expect(client.x).toHaveBeenCalledWith(...)`
  only restates the line above it. A spy may stand in for an outbound vendor call, never for the
  thing under test.

```ts
// bad - a mocked builder chain proves a call order, not a result
const db = { select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([row]) }) };
expect(db.select).toHaveBeenCalled();
// good - assert the outcome
expect(await service.get(id)).toEqual(row);
```

## How to write them

- Test behavior, not implementation - tests must survive a safe refactor (assert outputs, not
  private caches).
- Cover the change in the stacked test PR, never in the feature PR; always include the authz negatives.
- Drive a vendor's inbound side the way the vendor does: post the real webhook shape to the real
  route with a signature the stub's key material produces. Never call the adapter directly.
- Deterministic and isolated: no shared mutable state, no real outbound network, seedable data.
  Own the rows a test creates and clean them up - the API suite shares one database.
