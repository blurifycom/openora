# @blurifycom/testing - AGENTS.md

## What this package does

Shared test harness for integration suites, used by this repo's `apps/api`
integration tests and by downstream consumers. It boots the real Hono + oRPC app
in-process against a real Postgres test database - no mocks, no network listener.

## Exports

| Symbol                                             | Purpose                                                                                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setupTestDb()`                                    | Apply platform migrations to `TEST_DATABASE_URL` (default `oss_igaming_test`); returns `{ url, truncateAll(), dispose() }`.                                                                               |
| `bootTestApp({ plugins, contract?, databaseUrl })` | Wrap `@blurifycom/api-runtime` `createApp` for tests (OpenAPI off); returns `{ app, container, close }`. Drive `app` with `app.request()`.                                                                |
| `asPlayer(app, { email, password? })`              | Logs in a seeded player via `/identity/login` (verified session cookie - no `x-user-id` trust, ADR-0019). Seeded players: `player.<n>@demo.igaming.dev` / `password123`. Returns a `Promise<TestClient>`. |
| `asAdmin(app, creds?)`                             | Logs in via `/identity/login`, returns a `Promise<TestClient>` carrying the session cookie. Defaults to `admin@oss.dev` / `password123`.                                                                  |
| `seedMinimal(container, opts?)`                    | Thin wrapper over `seedDemoData` (admin + a few players + wallets).                                                                                                                                       |

## Usage (integration test)

```ts
import { setupTestDb, bootTestApp, asPlayer, asAdmin, seedMinimal } from '@blurifycom/testing';
import { loadExtensions } from '../../src/extensions.js';
import { contract } from '@blurifycom/orpc-contract';

let db, testApp;
beforeAll(async () => {
  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), contract, databaseUrl: db.url });
  await seedMinimal(testApp.container);
});
afterAll(async () => {
  await testApp.close();
  await db.dispose();
});
afterEach(() => db.truncateAll()); // or rely on unique ids per test
```

## Requirements / conventions

- A test Postgres must exist. CI provisions a `postgres:16` service; locally run
  `pnpm db:test:setup` (creates `oss_igaming_test`) with docker-compose postgres up.
- Integration vitest configs must `poolOptions.threads.singleThread = true` - all
  suites share one database, so they cannot run in parallel against it.
- `bootTestApp` requires the platform to be **built** (`loadExtensions()` resolves
  compiled `dist/**/plugin.js`). Run `pnpm build` before `pnpm test:integration`.
- Isolation: prefer unique tenant/user ids per test; use `truncateAll()` between
  files for a clean slate. Alternative (not wired here): wrap each test in a DB
  transaction and roll back - faster but requires the handler to use the txn.

## Don't

- Don't import this package from production code - it's test-only (`devDependencies`).
- Don't point `TEST_DATABASE_URL` at a real/dev database - `truncateAll()` wipes it.
