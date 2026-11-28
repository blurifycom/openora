# Testing

Read this before adding or restructuring a test.

## When a test is written

A feature or fix PR carries **its own tests**, written in the same branch from the manual
verification pass that proves the change works. There is no separate test PR.

Before the PR opens:

1. Drive the change against the running stack. Reach for the **Playwright CLI** first
   (`playwright-cli`, or a throwaway spec that clicks through the flow) - it costs a fraction of
   the tokens a browser MCP does. Use a browser MCP only for a live console or network read the CLI
   cannot give you. No videos in this pass, except a fix's "before" clip, recorded on the base
   branch when you reproduce the bug: the code can still change before review is clean. Every changed screen gets the
   `ui-verify` skill's screenshot review: four shots (mobile and desktop, light and dark), each
   read for layout defects and given a PASS or FAIL line. Screenshots are for the agent, videos
   for the reviewer.
2. Capture the evidence once, on the final commit, after the tests are green and review is clean:
   one clip per acceptance criterion with its whole flow in one take, from the screen the user starts
   on to the outcome it names (never a few seconds of the end state), plus a "before" clip
   recorded on the base branch on a fix (`ui-verify` "Video evidence"); a change that only alters how a
   screen looks gets before and after screenshots instead. Run every browser spec that drives an AC in one command with video on
   (`test.use({ video: 'on' })` or the repo's record switch); `playwright-cli` with `video-start` /
   `video-stop` only for an AC no spec drives. An API-only AC still gets its row, with sample
   request/response output instead of a clip.
3. Attach that evidence **to the PR description**, not only to your report - a reviewer confirms a
   change by looking at it.
4. Write the tests that pass exercised, in this branch, at the tier the table below names. Include
   the hostile paths and the authz negatives. A fix carries the test that fails without it.

A changed behaviour with no test is a review `[WARN]`, never a `[BLOCK]`, except on the paths below.

## Tests that catch the bug

A test that still passes when the code it covers is broken checks nothing. On a money, KYC,
responsible-gambling or authz path, break each changed check on purpose (flip a condition, move a
boundary by one, drop an owner check, change the sign of an amount) and run the tests: at least one
must fail. The tester does this in its pass and lists each break as a mutation row in its verdict
table; a break no test catches on those paths holds the PR until a test catches it. Where the repo
has a `test:mutation` script, it does the breaking for you; the repo-wide mutation score is shown,
not a gate.

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

A test asserts the outcome the caller sees, never the call order of a mocked builder chain. A
service test reads the row back through the service against real Postgres; the harness and the
stub-vendor helpers live under `@openora/testing`.

## How to write them

- Test behavior, not implementation - tests must survive a safe refactor (assert outputs, not
  private caches).
- Cover the change in the same PR as the change; always include the authz negatives, in the
  route's API E2E.
- Every test catches a regression no other test catches. Before adding one, name the bug it fails
  on; if an existing test already fails on that bug, do not add it. Cover an outcome once, at the
  outermost tier that reaches it; add an inner-tier test only for a branch, input or side effect
  (event, audit, ledger row) the outer one cannot reach. Pure-function tests stay branch-complete.
- Drive a vendor's inbound side the way the vendor does: post the real webhook shape to the real
  route with a signature the stub's key material produces. Never call the adapter directly.
- Deterministic and isolated: no shared mutable state, no real outbound network, seedable data.
  Own the rows a test creates and clean them up - the API suite shares one database.
