import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { walletAutoWithdrawalConfig } from '@openora/core/wallet/schema';
import { seedAutoWithdrawalConfig } from '@openora/core/wallet/seed';
import { definePlatformConfig, AutoWithdrawalConfigSchema } from '@openora/core/contracts';
import {
  setupTestDb,
  bootTestApp,
  applyMigrations,
  registerAndMaterializePlayer,
  asPlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * Independent QA verification of auto-withdrawal rules (a Super-Admin-editable,
 * DB-backed global auto-withdrawal threshold config), driven through the REAL app
 * (bootTestApp: real Hono + oRPC + Postgres + Redis) rather than the implementer's own
 * router-level tests, which mock AdminGuard/AdminUserDirectory and never exercise the
 * real DB-backed IAM RBAC resolver or the real seed/boot wiring. Two apps share one db:
 * - `appMain`: autoWithdrawal enabled, wallet_auto_withdrawal_config singleton SEEDED.
 * - `appUnseeded`: autoWithdrawal enabled, singleton row deliberately NOT seeded
 *   (fail-closed when the row is missing).
 */

let db: TestDb;
let appMain: TestApp;
let appUnseeded: TestApp;

let superAdmin: TestClient;
let paymentsManager: TestClient;
let plainAdmin: TestClient;
let bootstrapAdmin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function verifyKyc(admin: TestClient, userId: string) {
  const res = await admin.post(`/compliance/players/${userId}/kyc/override`, {
    status: 'approved',
    reason: 'QA fixture verification',
  });
  if (res.status !== 200) {
    throw new Error(`verifyKyc failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * Assigns a REAL DB-backed IAM role (bypassing the API, since assignRole itself
 * requires an existing super-admin - a legitimate bootstrap gap, not a bug).
 * This is what actually exercises the dynamic ADMIN_PERMISSION_RESOLVER path the
 * implementer's mocked-AdminGuard tests never touch.
 *
 * AdminGuard.assert first gates on the coarse static `user.role` column (must be
 * one of the statically-declared roles - admin/support/content-manager) BEFORE it
 * ever consults the DB-backed permission resolver; only once past that gate does a
 * bound resolver's per-user grants (from the DB assignment) become authoritative.
 * So a DB-backed role (super-admin, payments-manager, ...) needs BOTH the static
 * `user.role = 'admin'` coarse flag AND the specific admin_role_assignment row.
 */
async function assignIamRoleByKey(
  container: Container<CoreTokenCatalog>,
  userId: string,
  roleKey: string,
) {
  const drizzle = container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle.select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`assignIamRoleByKey: no seeded admin_role with key='${roleKey}'`);
  }
  await drizzle
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
}

async function setStaticRole(container: Container<CoreTokenCatalog>, userId: string, role: string) {
  await container.get(DRIZZLE).db.update(user).set({ role }).where(eq(user.id, userId));
}

let unseededDbName: string;
let unseededAdminClient: Client;

/**
 * `bootTestApp` apps in one file normally share ONE physical Postgres database
 * (only Redis is per-app-isolated) - see the implementer's own
 * wallet-ledger-auto-withdrawal.e2e.test.ts, which boots three apps against the
 * same `db.url`. wallet_auto_withdrawal_config is a true DB-wide singleton
 * (unique `singletonKey`), so a genuine "row is missing" scenario needs its own
 * physical database, not just its own app/container.
 */
async function createIsolatedTestDatabase(): Promise<string> {
  const baseUrl =
    process.env['TEST_DATABASE_URL'] ??
    'postgres://postgres:postgres@localhost:5432/oss_igaming_test';
  const url = new URL(baseUrl);
  const dbName = `unseeded_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({
    connectionString: `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  unseededAdminClient = admin;
  unseededDbName = dbName;
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.pathname = `/${dbName}`;
  return isolatedUrl.toString();
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();

  const fixture = fileURLToPath(
    new URL('./fixtures/qa-wallet-auto-withdrawal-config-plugin.ts', import.meta.url),
  );

  appMain = await bootTestApp({
    plugins: [...basePlugins, { id: 'qa-wallet-auto-withdrawal-config', path: fixture }],
    databaseUrl: db.url,
  });

  // seedMinimal reads process.env.DATABASE_URL (a global, set as a side effect of
  // the most-recently-booted app) rather than taking a url param, so appMain must
  // be fully seeded here BEFORE appUnseeded is booted below - otherwise this call
  // would silently reseed whichever app booted last (observed: a duplicate
  // admin@oss.dev registration collision when appUnseeded was booted first).
  await seedMinimal(appMain.container, { playerCount: 0 });
  // The singleton row is ONLY seeded by tools/db/seed.ts (pnpm db:seed) / the consumer
  // template in production - nothing in @openora/testing's bootTestApp/seedMinimal path
  // seeds it. Seed it explicitly for appMain; appUnseeded's separate database
  // deliberately never gets this call.
  await seedAutoWithdrawalConfig(appMain.container.get(DRIZZLE).db);

  const unseededUrl = await createIsolatedTestDatabase();
  await applyMigrations(unseededUrl);
  appUnseeded = await bootTestApp({
    plugins: [...basePlugins, { id: 'qa-wallet-auto-withdrawal-config', path: fixture }],
    databaseUrl: unseededUrl,
  });
  await seedMinimal(appUnseeded.container, { playerCount: 0 });

  const superAdminEmail = `super-admin-${randomUUID()}@e2e.test`;
  const { client: superAdminClient, userId: superAdminUserId } = await registerAndMaterializePlayer(
    appMain,
    { email: superAdminEmail },
  );
  await assignIamRoleByKey(appMain.container, superAdminUserId, 'super-admin');
  superAdmin = superAdminClient;

  const paymentsManagerEmail = `payments-manager-${randomUUID()}@e2e.test`;
  const { client: paymentsManagerClient, userId: paymentsManagerUserId } =
    await registerAndMaterializePlayer(appMain, { email: paymentsManagerEmail });
  await assignIamRoleByKey(appMain.container, paymentsManagerUserId, 'payments-manager');
  paymentsManager = paymentsManagerClient;

  const plainAdminEmail = `plain-admin-${randomUUID()}@e2e.test`;
  const { client: plainAdminClient, userId: plainAdminUserId } = await registerAndMaterializePlayer(
    appMain,
    { email: plainAdminEmail },
  );
  await assignIamRoleByKey(appMain.container, plainAdminUserId, 'admin');
  plainAdmin = plainAdminClient;

  const bootstrapAdminEmail = `bootstrap-admin-${randomUUID()}@e2e.test`;
  const { client: bootstrapAdminClient, userId: bootstrapAdminUserId } =
    await registerAndMaterializePlayer(appMain, { email: bootstrapAdminEmail });
  await setStaticRole(appMain.container, bootstrapAdminUserId, 'admin');
  bootstrapAdmin = bootstrapAdminClient;
}, 60_000);

afterAll(async () => {
  await appMain?.close();
  await appUnseeded?.close();
  await db?.dispose();
  if (unseededAdminClient) {
    await unseededAdminClient.query(`DROP DATABASE IF EXISTS "${unseededDbName}" WITH (FORCE)`);
    await unseededAdminClient.end();
  }
});

describe('authz: auto-withdrawal-config is super-admin only (real DB-backed IAM RBAC)', () => {
  it('super-admin succeeds on GET and PUT', async () => {
    const getRes = await superAdmin.get('/wallet/auto-withdrawal-config');
    expect(getRes.status).toBe(200);

    const setRes = await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '1',
      cryptoThreshold: '1',
      excludeRiskFlags: [],
    });
    expect(setRes.status).toBe(200);
  });

  it('payments-manager gets 403 on GET and PUT despite holding withdrawal:read_write', async () => {
    const getRes = await paymentsManager.get('/wallet/auto-withdrawal-config');
    expect(getRes.status).toBe(403);

    const setRes = await paymentsManager.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '1',
      cryptoThreshold: '1',
      excludeRiskFlags: [],
    });
    expect(setRes.status).toBe(403);
  });

  it('plain admin gets 403 on GET and PUT', async () => {
    const getRes = await plainAdmin.get('/wallet/auto-withdrawal-config');
    expect(getRes.status).toBe(403);

    const setRes = await plainAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '1',
      cryptoThreshold: '1',
      excludeRiskFlags: [],
    });
    expect(setRes.status).toBe(403);
  });

  it('bootstrap admin (static role fallback, no IAM assignment) succeeds on GET and PUT', async () => {
    const getRes = await bootstrapAdmin.get('/wallet/auto-withdrawal-config');
    expect(getRes.status).toBe(200);

    const setRes = await bootstrapAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '1',
      cryptoThreshold: '1',
      excludeRiskFlags: [],
    });
    expect(setRes.status).toBe(200);
  });

  it('anonymous (no session) gets 401, not 403', async () => {
    const getRes = await appMain.app.request('/wallet/auto-withdrawal-config');
    expect(getRes.status).toBe(401);
  });
});

describe('validation: threshold input', () => {
  it('rejects a negative fiat threshold', async () => {
    const res = await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '-1',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects a non-numeric crypto threshold', async () => {
    const res = await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '0',
      cryptoThreshold: 'not-a-number',
      excludeRiskFlags: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('a rejected update does not change the persisted config', async () => {
    const before = await readJson(await superAdmin.get('/wallet/auto-withdrawal-config'));
    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '-999',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    const after = await readJson(await superAdmin.get('/wallet/auto-withdrawal-config'));
    expect(after).toMatchObject({
      fiatThreshold: before.fiatThreshold,
      cryptoThreshold: before.cryptoThreshold,
    });
  });
});

describe('happy path: set -> immediate GET -> below/above threshold -> audit trail', () => {
  it('super-admin sets fiat/crypto thresholds, GET reflects immediately with no staleness', async () => {
    const setRes = await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '100',
      cryptoThreshold: '0.01',
      excludeRiskFlags: [],
    });
    expect(setRes.status).toBe(200);
    const set = await readJson(setRes);
    expect(set).toMatchObject({
      fiatThreshold: '100.000000000000000000',
      cryptoThreshold: '0.010000000000000000',
    });

    const getRes = await superAdmin.get('/wallet/auto-withdrawal-config');
    const got = await readJson(getRes);
    expect(got).toMatchObject({
      fiatThreshold: '100.000000000000000000',
      cryptoThreshold: '0.010000000000000000',
    });
  });

  it('a withdrawal below the fiat threshold auto-approves; one above stays pending; both leave audit trails', async () => {
    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '100',
      cryptoThreshold: '0.01',
      excludeRiskFlags: [],
    });

    const configAuditRes = await superAdmin.get(
      '/audit/logs?action=wallet.auto_withdrawal_config.set&limit=1',
    );
    const configAudit = await readJson(configAuditRes);
    expect(configAudit.items.length).toBeGreaterThanOrEqual(1);
    expect(configAudit.items[0].after).toMatchObject({
      fiatThreshold: '100.000000000000000000',
      cryptoThreshold: '0.010000000000000000',
    });
    expect(configAudit.items[0].before).toBeTruthy();

    const belowEmail = `below-${randomUUID()}@e2e.test`;
    const below = await registerAndMaterializePlayer(appMain, { email: belowEmail });
    await verifyKyc(superAdmin, below.userId);
    await below.client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '500',
      currency: 'USD',
    });
    const belowRes = await below.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '50',
      currency: 'USD',
    });
    expect(belowRes.status).toBe(200);
    const belowBody = await readJson(belowRes);
    expect(belowBody.status).toBe('completed');

    const aboveEmail = `above-${randomUUID()}@e2e.test`;
    const above = await registerAndMaterializePlayer(appMain, { email: aboveEmail });
    await verifyKyc(superAdmin, above.userId);
    await above.client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '500',
      currency: 'USD',
    });
    const aboveRes = await above.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '150',
      currency: 'USD',
    });
    expect(aboveRes.status).toBe(200);
    const aboveBody = await readJson(aboveRes);
    expect(aboveBody.status).toBe('pending');

    const pendingListRes = await superAdmin.get('/wallet/withdrawals?status=pending&limit=100');
    const pendingList = await readJson(pendingListRes);
    const pendingIds = new Set(
      (pendingList.items as Array<{ transactionId: string }>).map((i) => i.transactionId),
    );
    expect(pendingIds.has(aboveBody.transactionId)).toBe(true);
    expect(pendingIds.has(belowBody.transactionId)).toBe(false);

    const autoApprovedAuditRes = await superAdmin.get(
      `/audit/logs?resourceId=${belowBody.transactionId}&action=wallet.withdrawal.auto_approved`,
    );
    const autoApprovedAudit = await readJson(autoApprovedAuditRes);
    expect(autoApprovedAudit.items.length).toBeGreaterThanOrEqual(1);
    expect(autoApprovedAudit.items[0].actorType).toBe('system');
    expect(autoApprovedAudit.items[0].after).toMatchObject({
      userId: below.userId,
      threshold: '100.000000000000000000',
      thresholdSource: 'global',
    });
  });
});

describe('immediate effect: two consecutive config changes in one run', () => {
  it('each withdrawal picks up the latest threshold, no restart/cache needed', async () => {
    const email = `immediate-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appMain, { email: email });
    await verifyKyc(superAdmin, userId);
    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '500',
      currency: 'USD',
    });

    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '10',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    const first = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '20',
        currency: 'USD',
      }),
    );
    expect(first.status).toBe('pending');

    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '30',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    const second = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '20',
        currency: 'USD',
      }),
    );
    expect(second.status).toBe('completed');

    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '5',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    const third = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '20',
        currency: 'USD',
      }),
    );
    expect(third.status).toBe('pending');
  });
});

describe('precedence: per-player auto_withdrawal_rule vs the global config', () => {
  it('a per-player rule ABOVE the global threshold allows what global would block', async () => {
    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '10',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    const email = `rule-above-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appMain, { email: email });
    await verifyKyc(superAdmin, userId);
    await superAdmin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '1000',
      reason: 'QA: trusted player, rule above global',
    });

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '500',
      currency: 'USD',
    });
    const res = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '50',
        currency: 'USD',
      }),
    );
    expect(res.status).toBe('completed');

    const auditRes = await superAdmin.get(
      `/audit/logs?resourceId=${res.transactionId}&action=wallet.withdrawal.auto_approved`,
    );
    const audit = await readJson(auditRes);
    expect(audit.items[0].after).toMatchObject({ thresholdSource: 'per-player' });
  });

  it('a per-player rule BELOW the global threshold blocks what global would allow', async () => {
    await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    const email = `rule-below-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appMain, { email: email });
    await verifyKyc(superAdmin, userId);
    await superAdmin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '5',
      reason: 'QA: watchlist player, rule below global',
    });

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '500',
      currency: 'USD',
    });
    const res = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '50',
        currency: 'USD',
      }),
    );
    expect(res.status).toBe('pending');
  });
});

describe('fail-closed: the singleton config row is missing', () => {
  it('a withdrawal does not 500 and stays pending when wallet_auto_withdrawal_config has no row', async () => {
    const [row] = await appUnseeded.container
      .get(DRIZZLE)
      .db.select()
      .from(walletAutoWithdrawalConfig);
    expect(row).toBeUndefined();

    const email = `unseeded-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appUnseeded, { email: email });
    const admin = await asAdmin(appUnseeded.app);
    await verifyKyc(admin, userId);
    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '500',
      currency: 'USD',
    });

    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '10',
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');
  });

  it('BUG: GET /wallet/auto-withdrawal-config 500s instead of a mapped 404 when the row is missing (router/index.ts autoWithdrawalConfig.get skips mapErrors, unlike every sibling handler)', async () => {
    const email = `unseeded-superadmin-${randomUUID()}@e2e.test`;
    const { userId } = await registerAndMaterializePlayer(appUnseeded, { email: email });
    await assignIamRoleByKey(appUnseeded.container, userId, 'super-admin');
    const client = await asPlayer(appUnseeded.app, { email });

    const res = await client.get('/wallet/auto-withdrawal-config');
    // EXPECTED (once fixed): a mapped 404. ACTUAL today: an unhandled 500 - see
    // the QA report. This assertion intentionally documents the correct
    // contract and will start passing once router/index.ts wraps the handler
    // in mapErrors({ NOT_FOUND: AutoWithdrawalConfigNotFoundError }, ...).
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('FIXED: PUT /wallet/auto-withdrawal-config self-heals the missing row via upsert instead of 500ing (agreed fix: setAutoWithdrawalConfig is an upsert on the admin WRITE path only - the READ path still fails closed)', async () => {
    const email = `unseeded-set-${randomUUID()}@e2e.test`;
    const { userId } = await registerAndMaterializePlayer(appUnseeded, { email: email });
    await assignIamRoleByKey(appUnseeded.container, userId, 'super-admin');
    const client = await asPlayer(appUnseeded.app, { email });

    // A Super Admin trying to configure the feature for the first time on an
    // install where the seed script was never run previously got an unhandled
    // 500 with no way to recover via the API. The agreed fix upserts on the
    // admin write path, so PUT both creates the row and returns it - a clean
    // self-heal through the existing route, zero new surface.
    const res = await client.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '100',
      cryptoThreshold: '1',
      excludeRiskFlags: [],
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({
      fiatThreshold: '100.000000000000000000',
      cryptoThreshold: '1.000000000000000000',
    });

    const [row] = await appUnseeded.container
      .get(DRIZZLE)
      .db.select()
      .from(walletAutoWithdrawalConfig);
    expect(row).toMatchObject({
      fiatThreshold: '100.000000000000000000',
      cryptoThreshold: '1.000000000000000000',
    });
  });
});

describe('regression spot-check: static platform-config.yaml AutoWithdrawalConfigSchema', () => {
  it('still accepts the fields that stay static: enabled, dailyCapAmount, dailyCapCount', () => {
    const parsed = AutoWithdrawalConfigSchema.parse({
      enabled: true,
      dailyCapAmount: '5000',
      dailyCapCount: 10,
    });
    expect(parsed).toMatchObject({
      enabled: true,
      dailyCapAmount: '5000',
      dailyCapCount: 10,
    });
  });

  it('excludeRiskFlags moved to the DB-backed wallet_auto_withdrawal_config singleton and is no longer a static schema field', () => {
    expect(() =>
      AutoWithdrawalConfigSchema.parse({
        enabled: true,
        excludeRiskFlags: ['high_risk'],
      }),
    ).toThrow('excludeRiskFlags');
  });

  it('BUG: fiatThreshold/cryptoThreshold were removed from the static schema but two shipped e2e fixtures still set them, breaking pnpm build and bootTestApp at runtime', () => {
    expect(() =>
      definePlatformConfig({
        autoWithdrawal: {
          enabled: true,
          // @ts-expect-error -- this field was removed from the static schema; kept here to prove the
          // regression the two existing fixtures below still trigger.
          fiatThreshold: '2',
        },
      }),
    ).toThrow(/Unrecognized key: "fiatThreshold"/);
  });
});
