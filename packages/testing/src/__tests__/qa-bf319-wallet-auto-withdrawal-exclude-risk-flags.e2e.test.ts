import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import {
  setupTestDb,
  bootTestApp,
  asPlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * Independent QA verification of BF-319 (wallet auto-withdrawal tag-exclusion list moved
 * from static platform config to the DB-backed `wallet_auto_withdrawal_config` singleton's
 * `excludeRiskFlags` column, runtime-editable via `autoWithdrawalConfig.set`). The column
 * DEFAULT (5 tags, set at the migration level) is only a starting value for upgraded
 * installs - the DB value is the entire, sole source of truth at evaluation time, verbatim,
 * with no server-side floor unioned in; a Super Admin can clear it to `[]` to disable all
 * tag-based exclusion. Driven through the REAL app (bootTestApp: real Hono + oRPC + Postgres
 * + Redis + real tag module) rather than the implementer's own unit/router-level tests (which
 * mock PLAYER_TAGS / AdminGuard and never exercise a real tag assignment through the real tag
 * module + real IAM RBAC resolver end to end) - same rationale as the sibling BF-211 QA suite
 * this file extends.
 */

let db: TestDb;
let appMain: TestApp;
let superAdmin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function registerAndMaterializePlayer(app: TestApp['app'], email: string) {
  const registerRes = await app.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name: 'BF-319 QA Player' }),
  });
  if (!registerRes.ok) {
    throw new Error(`register failed (${registerRes.status}): ${await registerRes.text()}`);
  }
  const client = await asPlayer(app, { email });
  const profileRes = await client.get('/profile');
  if (!profileRes.ok) {
    throw new Error(
      `profile materialize failed (${profileRes.status}): ${await profileRes.text()}`,
    );
  }
  const profile = (await profileRes.json()) as { id: string; userId: string };
  return { client, playerId: profile.id, userId: profile.userId };
}

async function verifyKyc(admin: TestClient, userId: string) {
  const res = await admin.post(`/compliance/players/${userId}/kyc/override`, {
    status: 'approved',
    reason: 'BF-319 QA fixture verification',
  });
  if (res.status !== 200) {
    throw new Error(`verifyKyc failed (${res.status}): ${await res.text()}`);
  }
}

async function assignTag(admin: TestClient, playerId: string, tagKey: string) {
  const res = await admin.post(`/player/${playerId}/player-tag`, {
    tagKey,
    assignReason: 'BF-319 QA fixture - manual risk-tag seed',
    assignActor: 'manual',
  });
  if (res.status !== 200) {
    throw new Error(`assignTag(${tagKey}) failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

// Bootstrap a super-admin the same way the sibling BF-211 suite does: stamp the static
// user.role='admin' coarse gate, then attach the real DB-backed super-admin role
// assignment - both are required before the DB-backed permission resolver becomes
// authoritative (see BF-211 suite's own doc comment on AdminGuard.assert's two-stage gate).
async function makeSuperAdmin(
  app: TestApp['app'],
  container: Container<CoreTokenCatalog>,
  email: string,
) {
  const { client, userId } = await registerAndMaterializePlayer(app, email);
  const drizzle = container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle.select().from(adminRole).where(eq(adminRole.key, 'super-admin'));
  if (!role) {
    throw new Error("makeSuperAdmin: no seeded admin_role with key='super-admin'");
  }
  await drizzle
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
  return { client, userId };
}

async function setConfig(input: {
  fiatThreshold: string;
  cryptoThreshold: string;
  excludeRiskFlags: string[];
}) {
  const res = await superAdmin.put('/wallet/auto-withdrawal-config', input);
  if (res.status !== 200) {
    throw new Error(`setConfig failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();

  const fixture = fileURLToPath(
    new URL('./fixtures/qa-bf319-exclude-risk-flags-plugin.ts', import.meta.url),
  );

  appMain = await bootTestApp({
    plugins: [...basePlugins, { id: 'qa-bf319-exclude-risk-flags', path: fixture }],
    databaseUrl: db.url,
  });

  await seedMinimal(appMain.container, { playerCount: 0 });

  const superAdminEmail = `bf319-super-admin-${randomUUID()}@e2e.test`;
  const created = await makeSuperAdmin(appMain.app, appMain.container, superAdminEmail);
  superAdmin = created.client;
}, 60_000);

afterAll(async () => {
  await appMain?.close();
  await db?.dispose();
});

describe('BF-319 upgraded install: the migration DEFAULT tags gate before any admin ever edits excludeRiskFlags', () => {
  it('a singleton row seeded with NO explicit excludeRiskFlags (column DEFAULT applies) gates a tagged player and lets a clean player through', async () => {
    // Directly insert the singleton row the way `seedAutoWithdrawalConfig` does in
    // production - a positive threshold so the tag gate (not the threshold gate) is what's
    // under test, and deliberately OMITTING excludeRiskFlags so the column's migration-level
    // DEFAULT (5 tags, a starting value only - not an enforced floor) applies, matching a
    // genuine "just upgraded, never touched by an admin" install. Delete any pre-existing
    // row first: this file's
    // apps share one physical test database across the whole `test:integration` run (per
    // @openora/testing's AGENTS.md), so a sibling suite may have already seeded/edited the
    // singleton before this file runs - this test needs the row to be genuinely
    // untouched-since-insert to prove the DEFAULT, not whatever a previous file left behind.
    const configDb = appMain.container.get(DRIZZLE).db;
    await configDb.delete(walletAutoWithdrawalConfig);
    await configDb
      .insert(walletAutoWithdrawalConfig)
      .values({ singletonKey: 'global', fiatThreshold: '1000', cryptoThreshold: '0' });

    const getRes = await superAdmin.get('/wallet/auto-withdrawal-config');
    expect(getRes.status).toBe(200);
    const got = await readJson(getRes);
    expect(new Set(got.excludeRiskFlags)).toEqual(
      new Set(['high_risk', 'bonus_abuser', 'kyc_rejected', 'withdrawal_review', 'multi_account']),
    );

    const taggedEmail = `bf319-preexisting-tagged-${randomUUID()}@e2e.test`;
    const tagged = await registerAndMaterializePlayer(appMain.app, taggedEmail);
    await verifyKyc(superAdmin, tagged.userId);
    await assignTag(superAdmin, tagged.playerId, 'high_risk');
    await tagged.client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const taggedRes = await readJson(
      await tagged.client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(taggedRes.status).toBe('pending');

    const cleanEmail = `bf319-preexisting-clean-${randomUUID()}@e2e.test`;
    const clean = await registerAndMaterializePlayer(appMain.app, cleanEmail);
    await verifyKyc(superAdmin, clean.userId);
    await clean.client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const cleanRes = await readJson(
      await clean.client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(cleanRes.status).toBe('completed');
  });
});

describe('BF-319 immediate effect: PUT excludeRiskFlags, GET reflects it right away, no restart needed', () => {
  it('a super-admin widens the exclusion set with a tag and GET reflects it immediately', async () => {
    const set = await setConfig({
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['vip'],
    });
    expect(set.excludeRiskFlags).toEqual(['vip']);

    const got = await readJson(await superAdmin.get('/wallet/auto-withdrawal-config'));
    expect(got.excludeRiskFlags).toEqual(['vip']);
  });

  it('a player carrying the newly-configured tag is now excluded from auto-approval', async () => {
    await setConfig({ fiatThreshold: '1000', cryptoThreshold: '0', excludeRiskFlags: ['vip'] });

    const email = `bf319-widened-tag-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await assignTag(superAdmin, playerId, 'vip');
    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(res.status).toBe('pending');
  });
});

describe('BF-319 full admin control: excludeRiskFlags is the sole source of truth, no server-side floor', () => {
  it('an admin submits an empty excludeRiskFlags array, GET reflects the empty array, and a previously-excluded tag no longer blocks auto-approval', async () => {
    const set = await setConfig({
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: [],
    });
    expect(set.excludeRiskFlags).toEqual([]);
    const got = await readJson(await superAdmin.get('/wallet/auto-withdrawal-config'));
    expect(got.excludeRiskFlags).toEqual([]);

    const email = `bf319-empty-array-clears-exclusion-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await assignTag(superAdmin, playerId, 'high_risk');
    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(res.status).toBe('completed');
  });

  it("an admin's excludeRiskFlags submission is authoritative - a tag omitted from the submitted list is no longer excluded, even one that used to be part of the migration DEFAULT", async () => {
    // Submit every migration-DEFAULT tag EXCEPT kyc_rejected - proves the admin's own list,
    // not any server-side union, decides what's excluded. kyc_rejected is a plain KYC-status
    // gate elsewhere (autoApprovalKycStatus), so keep this player's KYC status passing and
    // rely solely on the tag to isolate the tag-exclusion gate under test.
    await setConfig({
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['withdrawal_review', 'multi_account', 'high_risk', 'bonus_abuser'],
    });

    const email = `bf319-omitted-tag-no-longer-excluded-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await assignTag(superAdmin, playerId, 'kyc_rejected');
    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(res.status).toBe('completed');
  });
});

describe('BF-319 effective set = the DB value verbatim: excluded regardless of amount when otherwise eligible', () => {
  it('a player carrying a configured tag stays pending even for a tiny, well-under-threshold amount', async () => {
    await setConfig({
      fiatThreshold: '5000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['vip'],
    });

    const email = `bf319-tiny-amount-excluded-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await assignTag(superAdmin, playerId, 'vip');
    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '1', currency: 'USD' }),
    );
    expect(res.status).toBe('pending');
  });
});

describe('BF-319 regression (no weakening): a player with no excluded tag, under threshold, KYC-approved still auto-approves', () => {
  it('auto-approves exactly as BF-211 behaved, with the exclusion set configured but not held by this player', async () => {
    await setConfig({
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['vip'],
    });

    const email = `bf319-no-regression-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(res.status).toBe('completed');
  });
});

describe('BF-319 per-player override does not bypass the tag-exclusion gate', () => {
  it('a per-player threshold override far above the amount still leaves a tag-excluded player pending', async () => {
    await setConfig({
      fiatThreshold: '10',
      cryptoThreshold: '0',
      excludeRiskFlags: ['multi_account'],
    });

    const email = `bf319-rule-override-excluded-tag-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await assignTag(superAdmin, playerId, 'multi_account');
    await superAdmin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '10000',
      reason: 'BF-319 QA: trusted-looking player, still carries an excluded tag',
    });

    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(res.status).toBe('pending');
  });
});

describe('BF-319 audit trail', () => {
  it("setAutoWithdrawalConfig's audit record captures the excludeRiskFlags before/after diff", async () => {
    await setConfig({ fiatThreshold: '1000', cryptoThreshold: '0', excludeRiskFlags: ['vip'] });
    const set = await setConfig({
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['vip', 'large_depositor'],
    });

    const auditRes = await superAdmin.get(
      `/audit/logs?action=wallet.auto_withdrawal_config.set&limit=1`,
    );
    const audit = await readJson(auditRes);
    expect(audit.items.length).toBeGreaterThanOrEqual(1);
    const entry = audit.items[0];
    expect(entry.before.excludeRiskFlags).toEqual(['vip']);
    expect(entry.after.excludeRiskFlags).toEqual(['vip', 'large_depositor']);
    expect(set.excludeRiskFlags).toEqual(['vip', 'large_depositor']);
  });

  it('the auto-approval audit record includes effectiveExcludeTags as the DB value verbatim, not just riskTagsEvaluated', async () => {
    await setConfig({
      fiatThreshold: '1000',
      cryptoThreshold: '0',
      excludeRiskFlags: ['large_depositor'],
    });

    const email = `bf319-audit-effective-tags-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appMain.app, email);
    await verifyKyc(superAdmin, userId);
    await client.post('/wallet/deposit', { amount: '500', currency: 'USD' });
    const res = await readJson(
      await client.post('/wallet/withdraw', { amount: '50', currency: 'USD' }),
    );
    expect(res.status).toBe('completed');

    const auditRes = await superAdmin.get(
      `/audit/logs?resourceId=${res.transactionId}&action=wallet.withdrawal.auto_approved`,
    );
    const audit = await readJson(auditRes);
    expect(audit.items.length).toBeGreaterThanOrEqual(1);
    const after = audit.items[0].after;
    expect(after.effectiveExcludeTags).toEqual(['large_depositor']);
    expect(after.riskTagsEvaluated).toEqual([]);
  });
});

describe('BF-319 validation: excludeRiskFlags is now a required input field', () => {
  it('a PUT omitting excludeRiskFlags entirely is rejected with a validation error, not silently defaulted', async () => {
    const before = await readJson(await superAdmin.get('/wallet/auto-withdrawal-config'));

    const res = await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '42',
      cryptoThreshold: '0',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = await readJson(await superAdmin.get('/wallet/auto-withdrawal-config'));
    expect(after).toMatchObject({
      fiatThreshold: before.fiatThreshold,
      cryptoThreshold: before.cryptoThreshold,
      excludeRiskFlags: before.excludeRiskFlags,
    });
  });

  it('a PUT with excludeRiskFlags containing an unknown tag key is rejected', async () => {
    const res = await superAdmin.put('/wallet/auto-withdrawal-config', {
      fiatThreshold: '1',
      cryptoThreshold: '1',
      excludeRiskFlags: ['not_a_real_tag_key'],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
