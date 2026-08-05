# Testing

Detail for the testing lines in `conventions`. Read this before adding or restructuring a test.

## Tiers

- **Co-locate as `__tests__/<name>.test.ts` (Vitest).**
- **A file that calls `createTestDb`/`createTestRedis` is named `<name>.int.test.ts`** and runs in `test:integration` (needs docker Postgres + Redis); `test:unit` is the infra-free suite and stays a ~4s loop. Lint-enforced by `oss-module-shape/int-test-file-naming`.
- The end-to-end tier lives in `@openora/testing` (`bootTestApp` against a shared test db). Recreate that db with `pnpm db:setup:test:fresh` if a migration was edited after it was applied locally - drizzle hashes each migration file's bytes, so a stale hash re-runs an applied migration.
- Integration Vitest configs using `@openora/testing` run with `poolOptions.threads.singleThread = true`: the harness shares one test database. Build before `pnpm test:integration`, because extension loading resolves compiled plugins.

## What is real, what is doubled

- **Anything that touches the database is tested against real Postgres** - `createTestDb([migrate])` (`@openora/core/testing`) gives the file its own ephemeral database; `createTestRedis()` gives it a per-worker Redis logical DB. Never fake a query builder: a mocked chain proves a call order, not a result, so it misses the regressions that matter (unique-index dedupe, `FOR UPDATE` under concurrency, conditional atomic updates, cache invalidation).
- **What stays mocked:** external vendors (PSP, KYC, email, SMS, better-auth) and cross-module ports (`WALLET_COMMANDS`, `IdentityReader`, `EventBus`, `Logger`) - via the shared doubles in `packages/core/src/testing/mock.ts` (`mock`, `makeEventBus`, `makeAuditWriter`, `makeAdminGuard`, `testContext`), never a hand-rolled one in the test file. Engine (`server/**`) tests cannot import a domain schema (ADR-0024/0025), so they use the in-process implementations re-exported from `@openora/core/testing`.
- Every tier binds the drivers production binds (ADR-0032) - there are no in-process broker/queue/cache/rate-limiter doubles to fall back to.

## How to write them

- **Test behaviour, not implementation** - assert the resulting rows, cache state, and return value, not that a builder method was called: `expect(await service.get(id)).toEqual(user)`, not `expect(db.select).toHaveBeenCalled()`.

  ```ts
  // bad - a mocked builder chain; proves a call order, not a result
  const db = { select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([row]) }) };
  expect(db.select).toHaveBeenCalled();
  // good - real Postgres per file, external ports doubled through the mock helper
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb([migrateProfile, migrate]);
  });
  afterAll(() => db.drop());
  const svc = new TagService(db.drizzle, makeEventBus());
  await expect(svc.assign(assignment)).rejects.toThrow(TagNotFoundError);
  ```

  Canonical integration test to copy: `packages/core/src/pam/tag/__tests__/tag.service.int.test.ts` (ephemeral db, seeded rows, event assertions). Pure-logic reference: `packages/core/src/wallet/__tests__/rail-for.test.ts`.

- **Cover new logic as part of the change** - unit for pure fns; always include authz negatives.
- **Deterministic and isolated:** no shared mutable state, no real network, seedable data. Real-infra suites stay parallel-safe - own your database and Redis keys, never assume an empty shared one.
- `@openora/testing` is test-only. Never import it from production code or point `TEST_DATABASE_URL` at a real or development database: its cleanup truncates data.
- Run one file or dir with `pnpm -F @openora/core vitest run <path>`; find the tests touching a file with `pnpm -F @openora/core vitest related <path>`.
