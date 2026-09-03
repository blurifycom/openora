import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { walletAutoWithdrawalConfig } from '@openora/core/wallet/schema';
import { seedAutoWithdrawalConfig } from '@openora/core/wallet/seed';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  asAdmin,
  seedMinimal,
  waitForEmail,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * E2E for ABC-214 (wallet ledger + auto-withdrawal) over real HTTP + Postgres. Three apps share one db:
 * - `appDefault`: stock stack, autoWithdrawal off (manual approve/reject, rule-route authz).
 * - `appGated`: autoWithdrawal enabled, fiatThreshold 2, high caps - single-shot gate scenarios.
 * - `appCapGated`: dailyCapCount 1 - the daily-cap scenario isolated from the velocity heuristic.
 */

let db: TestDb;
let appDefault: TestApp;
let appGated: TestApp;
let appCapGated: TestApp;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function setRole(container: Container<CoreTokenCatalog>, userId: string, role: string) {
  await container.get(DRIZZLE).db.update(user).set({ role }).where(eq(user.id, userId));
}

async function verifyKyc(admin: TestClient, userId: string) {
  const res = await admin.post(`/compliance/players/${userId}/kyc/override`, {
    tier: 'basic',
    status: 'approved',
    reason: 'e2e fixture verification',
  });
  if (res.status !== 200) {
    throw new Error(`verifyKyc failed (${res.status}): ${await res.text()}`);
  }
}

async function assignTag(admin: TestClient, playerId: string, tagKey: string) {
  const res = await admin.post(`/player/${playerId}/player-tag`, {
    tagKey,
    assignReason: 'qa e2e fixture',
    assignActor: 'manual',
  });
  if (res.status !== 200) {
    throw new Error(`assignTag failed (${res.status}): ${await res.text()}`);
  }
}

async function pendingWithdrawalIds(admin: TestClient, currency = 'USD') {
  const res = await admin.get(`/wallet/withdrawals?status=pending&currency=${currency}&limit=100`);
  const body = await readJson(res);
  return new Set((body.items as Array<{ transactionId: string }>).map((i) => i.transactionId));
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();

  appDefault = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });

  const gatedFixture = fileURLToPath(
    new URL('./fixtures/test-wallet-auto-withdrawal-config-plugin.ts', import.meta.url),
  );
  appGated = await bootTestApp({
    plugins: [...basePlugins, { id: 'test-wallet-auto-withdrawal-config', path: gatedFixture }],
    databaseUrl: db.url,
  });

  const capFixture = fileURLToPath(
    new URL('./fixtures/test-wallet-auto-withdrawal-cap-config-plugin.ts', import.meta.url),
  );
  appCapGated = await bootTestApp({
    plugins: [...basePlugins, { id: 'test-wallet-auto-withdrawal-cap-config', path: capFixture }],
    databaseUrl: db.url,
  });

  // The global fiat/crypto threshold moved from static PLATFORM_CONFIG to the
  // DB-backed wallet_auto_withdrawal_config singleton. appGated/appCapGated share this
  // physical database with appDefault, so seeding it once here (fiatThreshold '2', matching
  // what the two fixtures used to set statically) covers both single-shot gate and daily-cap
  // scenarios below - the seed default ('0'/'0') would otherwise leave auto-approval off.
  // Delete any pre-existing row first: this suite's excluded-risk-tag scenario below relies
  // on the column's migration DEFAULT for excludeRiskFlags, and this file's apps share one
  // physical test database with every other e2e file in the run (per @openora/testing's
  // AGENTS.md) - a sibling suite may have already left the singleton with an admin-edited
  // excludeRiskFlags value that no longer includes the tag this suite tests.
  const configDb = appDefault.container.get(DRIZZLE).db;
  await configDb.delete(walletAutoWithdrawalConfig);
  await seedAutoWithdrawalConfig(configDb);
  await configDb
    .update(walletAutoWithdrawalConfig)
    .set({ fiatThreshold: '2' })
    .where(eq(walletAutoWithdrawalConfig.singletonKey, 'global'));

  await seedMinimal(appDefault.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await appDefault?.close();
  await appGated?.close();
  await appCapGated?.close();
  await db?.dispose();
});

describe('Auto-withdrawal: single-shot gates (appGated - fiatThreshold 2)', () => {
  it('auto-completes a fiat withdrawal under threshold, with a KYC-verified untagged player', async () => {
    const email = `auto-ok-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, userId);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'USD',
    });
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.5',
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('completed');

    const balance = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balance).toBe('4.500000000000000000');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(body.transactionId)).toBe(false);

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${body.transactionId}&action=wallet.withdrawal.auto_approved`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.items[0].actorType).toBe('system');
      expect(auditBody.items[0].after).toMatchObject({
        userId,
        threshold: '2.000000000000000000',
        thresholdSource: 'global',
        kycStatus: 'manually_overridden',
        riskTagsEvaluated: [],
      });
    });
  });

  it('stays pending when KYC is not verified/manually_overridden, even though kyc.gateWithdrawals is off', async () => {
    const email = `auto-kyc-pending-${randomUUID()}@e2e.test`;
    const { client } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);
    // No verifyKyc() call - player stays at the default kycStatus 'pending'.

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '3',
      currency: 'USD',
    });
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.5',
      currency: 'USD',
    });
    // gateWithdrawals is off, so the withdraw request itself succeeds...
    expect(res.status).toBe(200);
    const body = await readJson(res);
    // ...but the auto-approval KYC gate is independent and fails closed to manual.
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('stays pending when the player carries an excluded risk tag', async () => {
    const email = `auto-risk-tag-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated, {
      email: email,
    });
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, userId);
    await assignTag(admin, playerId, 'high_risk');

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '3',
      currency: 'USD',
    });
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.5',
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('stays pending when the amount exceeds the resolved threshold', async () => {
    const email = `auto-over-threshold-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, userId);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'USD',
    });
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '2.5',
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('never auto-approves the crypto rail, regardless of config', async () => {
    const email = `auto-crypto-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, userId);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '0.1',
      currency: 'BTC',
    });
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.01',
      currency: 'BTC',
      destinationAddress: 'bc1qe2e-crypto-rail-test-address',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin, 'BTC');
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('a lower per-player rule blocks what the global threshold would allow', async () => {
    const email = `auto-rule-blocks-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, userId);

    const setRes = await admin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '0.1',
      reason: 'watchlist - lower ceiling',
    });
    expect(setRes.status).toBe(200);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'USD',
    });
    // 0.4 is well under the global 2 threshold but over the per-player rule's 0.1.
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.4',
      currency: 'USD',
    });
    const body = await readJson(res);
    expect(body.status).toBe('pending');
  });

  it('a higher per-player rule allows what the global threshold would block', async () => {
    const email = `auto-rule-allows-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, userId);

    const setRes = await admin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '3',
      reason: 'trusted long-standing player',
    });
    expect(setRes.status).toBe(200);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'USD',
    });
    // 2.5 exceeds the global 2 threshold but is under the per-player rule's 3.
    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '2.5',
      currency: 'USD',
    });
    const body = await readJson(res);
    expect(body.status).toBe('completed');

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${body.transactionId}&action=wallet.withdrawal.auto_approved`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items[0].after).toMatchObject({
        threshold: '3.000000000000000000',
        thresholdSource: 'per-player',
      });
    });
  });
});

describe('Auto-withdrawal: daily cap (appCapGated - dailyCapCount 1)', () => {
  it('auto-approves the first fiat withdrawal, then stays pending once the daily cap is used', async () => {
    const email = `auto-cap-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appCapGated, { email: email });
    const admin = await asAdmin(appCapGated.app);
    await verifyKyc(admin, userId);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'USD',
    });

    const first = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '0.3',
        currency: 'USD',
      }),
    );
    expect(first.status).toBe('completed');

    const second = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '0.3',
        currency: 'USD',
      }),
    );
    expect(second.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(second.transactionId)).toBe(true);
    expect(pending.has(first.transactionId)).toBe(false);
  });
});

describe('Auto-withdrawal-rule routes: authz + audit', () => {
  it('PUT/GET/DELETE require auth (401) and withdrawal:auto-rule (403), succeed for admin', async () => {
    const email = `rule-authz-${randomUUID()}@e2e.test`;
    const { userId } = await registerAndMaterializePlayer(appDefault, { email: email });
    const admin = await asAdmin(appDefault.app);

    const staffEmail = `rule-staff-${randomUUID()}@e2e.test`;
    const { client: staffClient, userId: staffUserId } = await registerAndMaterializePlayer(
      appDefault,
      { email: staffEmail },
    );
    // `support` has other admin permissions but not `withdrawal:auto-rule`.
    await setRole(appDefault.container, staffUserId, 'support');

    // 401: no session at all.
    const anonSet = await appDefault.app.request(`/wallet/auto-withdrawal-rules/${userId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: '1', reason: 'no session' }),
    });
    expect(anonSet.status).toBe(401);
    const anonGet = await appDefault.app.request(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(anonGet.status).toBe(401);
    const anonDel = await appDefault.app.request(`/wallet/auto-withdrawal-rules/${userId}`, {
      method: 'DELETE',
    });
    expect(anonDel.status).toBe(401);

    // 403: authenticated but missing the specific permission.
    const staffSet = await staffClient.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '1',
      reason: 'should be denied',
    });
    expect(staffSet.status).toBe(403);
    const staffGet = await staffClient.get(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(staffGet.status).toBe(403);
    const staffDel = await staffClient.del(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(staffDel.status).toBe(403);

    // Admin: full round trip + audit trail on set and delete.
    const setRes = await admin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: '1.5',
      reason: 'admin round trip',
    });
    expect(setRes.status).toBe(200);
    const rule = await readJson(setRes);
    expect(rule).toMatchObject({
      userId,
      threshold: '1.500000000000000000',
      reason: 'admin round trip',
    });

    const getRes = await admin.get(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(getRes.status).toBe(200);
    expect(await readJson(getRes)).toMatchObject({ threshold: '1.500000000000000000' });

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${userId}&action=wallet.auto_withdrawal_rule.set`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.items[0].after).toMatchObject({
        threshold: '1.500000000000000000',
        reason: 'admin round trip',
      });
    });

    const delRes = await admin.del(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(delRes.status).toBe(200);
    expect(await readJson(delRes)).toBe(true);

    const afterDelete = await admin.get(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(await readJson(afterDelete)).toBeNull();

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${userId}&action=wallet.auto_withdrawal_rule.deleted`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('Manual withdrawal approve/reject regression (appDefault - autoWithdrawal off)', () => {
  it('approve settles the payout; reject returns the held funds', async () => {
    const email = `manual-flow-${randomUUID()}@e2e.test`;
    const { client } = await registerAndMaterializePlayer(appDefault, { email: email });
    const admin = await asAdmin(appDefault.app);

    await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '3',
      currency: 'USD',
    });

    const w1 = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '0.6',
        currency: 'USD',
      }),
    );
    expect(w1.status).toBe('pending');
    const balanceAfterHold = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balanceAfterHold).toBe('2.400000000000000000');

    const approveRes = await admin.post(`/wallet/withdrawals/${w1.transactionId}/approve`, {
      withdrawalId: w1.transactionId,
    });
    expect(approveRes.status).toBe(200);
    expect((await readJson(approveRes)).status).toBe('completed');

    // One `wallet.withdrawal.approved` event drives BOTH channels through the
    // notifications module: the in-app notification row and, alongside it, the
    // `withdrawalApproved` email enqueued onto `mail-send`.
    await vi.waitFor(async () => {
      const items = (await readJson(await client.get('/notifications'))).items as Array<{
        type: string;
      }>;
      expect(items.some((n) => n.type === 'withdrawal.approved')).toBe(true);
    });
    const approvedMail = await waitForEmail(
      email,
      (m) => m.subject === 'Your withdrawal was approved',
    );
    expect(approvedMail.text).toContain(w1.transactionId);

    const w2 = await readJson(
      await client.post('/wallet/withdraw', {
        idempotencyKey: randomUUID(),
        amount: '0.4',
        currency: 'USD',
      }),
    );
    expect(w2.status).toBe('pending');
    const balanceAfterSecondHold = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balanceAfterSecondHold).toBe('2.000000000000000000');

    const rejectRes = await admin.post(`/wallet/withdrawals/${w2.transactionId}/reject`, {
      withdrawalId: w2.transactionId,
      reason: 'qa regression check',
    });
    expect(rejectRes.status).toBe(200);
    expect((await readJson(rejectRes)).status).toBe('rejected');

    const rejectedMail = await waitForEmail(
      email,
      (m) => m.subject === 'Your withdrawal was rejected',
    );
    expect(rejectedMail.text).toContain('qa regression check');

    const balanceAfterReject = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balanceAfterReject).toBe('2.400000000000000000');
  });
});
