# @openora/testing

Shared harness for integration suites (ours and downstream consumers'): boots the real Hono + oRPC app in-process against a real Postgres test database - no mocks, no network listener. `setupTestDb` migrates and hands back `truncateAll`/`dispose`; `bootTestApp` returns `{ app, container, close }` you drive with `app.request()`; `asPlayer`/`asAdmin` log in through `/identity/login` for a real session cookie (no `x-user-id` trust, ADR-0019); `seedMinimal` wraps `seedDemoData`.

## Requirements

- A test Postgres must exist: CI provisions `postgres:16`, locally `pnpm db:setup:test` against docker-compose postgres.
- Integration vitest configs MUST set `poolOptions.threads.singleThread = true` - every suite shares one database, so they cannot run in parallel.
- `bootTestApp` needs the platform BUILT (`loadExtensions()` resolves compiled `dist/**/plugin.js`) - run `pnpm build` before `pnpm test:integration`.
- Isolate with unique ids per test, or `truncateAll()` between files. (A per-test transaction rollback would be faster but requires handlers to take the txn - not wired here.)

## Don't

- Import this package from production code - it is test-only.
- Point `TEST_DATABASE_URL` at a real or dev database: `truncateAll()` wipes it.
