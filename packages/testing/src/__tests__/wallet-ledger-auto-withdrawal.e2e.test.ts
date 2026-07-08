import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE, EVENT_BUS, type Container } from '@blurifycom/core/server';
import { REALTIME_TRANSPORT, WALLET_COMMANDS, PLATFORM_CONFIG } from '@blurifycom/core/contracts';
import { SportsbookService } from '@blurifycom/core/sportsbook/server';
import { sportsbookEvent, sportsbookSelection } from '@blurifycom/core/sportsbook/schema';
import { user } from '@blurifycom/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  asPlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * E2E for ABC-214 (wallet ledger + auto-withdrawal) over real HTTP + Postgres. Three apps share one db:
 * - `appDefault`: stock stack, autoWithdrawal off (sportsbook ledger, manual approve/reject, rule-route authz).
 * - `appGated`: autoWithdrawal enabled, fiatThreshold 200, high caps - single-shot gate scenarios.
 * - `appCapGated`: dailyCapCount 1 - the daily-cap scenario isolated from the velocity heuristic.
 *
 * `settleBet` has no oRPC route yet, so it's exercised by instantiating SportsbookService against the app's container.
 */

let db: TestDb;
let appDefault: TestApp;
let appGated: TestApp;
let appCapGated: TestApp;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function registerAndMaterializePlayer(app: TestApp['app'], email: string) {
  const registerRes = await app.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name: 'Wallet E2E Player' }),
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

async function setRole(container: Container, userId: string, role: string) {
  await container.get(DRIZZLE).db.update(user).set({ role }).where(eq(user.id, userId));
}

async function verifyKyc(admin: TestClient, playerId: string) {
  const res = await admin.patch(`/players/${playerId}`, { kycStatus: 'verified' });
  if (res.status !== 200) throw new Error(`verifyKyc failed (${res.status}): ${await res.text()}`);
}

async function assignTag(admin: TestClient, playerId: string, tagKey: string) {
  const res = await admin.post(`/player/${playerId}/player-tag`, {
    tagKey,
    assignReason: 'qa e2e fixture',
    assignActor: 'manual',
  });
  if (res.status !== 200) throw new Error(`assignTag failed (${res.status}): ${await res.text()}`);
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

  await seedMinimal(appDefault.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await appDefault?.close();
  await appGated?.close();
  await appCapGated?.close();
  await db?.dispose();
});

describe('Sportsbook ledger: bet debit + settleBet credit/loss (no route - direct service call)', () => {
  it('a bet debits type=bet, a win credits type=win, a loss writes a 0-amount type=loss row', async () => {
    const email = `sb-ledger-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appDefault.app, email);

    const depositRes = await client.post('/wallet/deposit', { amount: 500, currency: 'USD' });
    expect(depositRes.status).toBe(200);
    const balance0 = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balance0).toBe(500);

    const drizzle = appDefault.container.get(DRIZZLE).db;
    const [event] = await drizzle
      .insert(sportsbookEvent)
      .values({
        sport: 'football',
        league: 'e2e-league',
        homeTeam: 'QA Home',
        awayTeam: 'QA Away',
        startsAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    const [selection] = await drizzle
      .insert(sportsbookSelection)
      .values({ eventId: event!.id, label: 'home', odds: 2 })
      .returning();

    const bet1Res = await client.post('/sportsbook/bets', {
      selectionId: selection!.id,
      stake: 20,
    });
    expect(bet1Res.status).toBe(200);
    const bet1 = await readJson(bet1Res);
    expect(bet1.newBalance).toBe(480);

    const bet2Res = await client.post('/sportsbook/bets', {
      selectionId: selection!.id,
      stake: 20,
    });
    expect(bet2Res.status).toBe(200);
    const bet2 = await readJson(bet2Res);
    expect(bet2.newBalance).toBe(460);

    const afterBets = await readJson(await client.get('/wallet/transactions?limit=100'));
    const betRows = afterBets.items.filter((t: { type: string }) => t.type === 'bet');
    expect(betRows).toHaveLength(2);
    expect(betRows.every((t: { amount: number; status: string }) => t.amount === 20)).toBe(true);
    expect(betRows.every((t: { status: string }) => t.status === 'completed')).toBe(true);

    const sportsbookSvc = new SportsbookService({
      drizzle: appDefault.container.get(DRIZZLE),
      events: appDefault.container.get(EVENT_BUS),
      transport: appDefault.container.get(REALTIME_TRANSPORT),
      walletCommands: appDefault.container.get(WALLET_COMMANDS),
      ...(appDefault.container.has(PLATFORM_CONFIG)
        ? { platformConfig: appDefault.container.get(PLATFORM_CONFIG) }
        : {}),
    });

    const settledWin = await sportsbookSvc.settleBet(bet1.bet.id, 'win');
    expect(settledWin.bet.status).toBe('settled');
    const balanceAfterWin = (await readJson(await client.get('/wallet/balance'))).balance;
    // potentialReturn = 20 stake * 2 odds = 40, credited on top of the 460 post-bets balance.
    expect(balanceAfterWin).toBe(500);

    const settledLoss = await sportsbookSvc.settleBet(bet2.bet.id, 'loss');
    expect(settledLoss.bet.status).toBe('settled');
    const balanceAfterLoss = (await readJson(await client.get('/wallet/balance'))).balance;
    // A loss never touches the balance - the stake already left at bet time.
    expect(balanceAfterLoss).toBe(500);

    const finalTx = await readJson(await client.get('/wallet/transactions?limit=100'));
    const winRow = finalTx.items.find((t: { type: string }) => t.type === 'win');
    const lossRow = finalTx.items.find((t: { type: string }) => t.type === 'loss');
    expect(winRow).toMatchObject({ amount: 40, status: 'completed' });
    expect(lossRow).toMatchObject({ amount: 0, status: 'completed' });

    // Settle-once guard: a repeated settle is a no-op replay, never a second credit.
    await sportsbookSvc.settleBet(bet1.bet.id, 'win');
    const balanceAfterReplay = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balanceAfterReplay).toBe(500);

    // Backoffice-equivalent surface: the admin per-player ledger read shows the same rows.
    const admin = await asAdmin(appDefault.app);
    const adminTx = await readJson(await admin.get(`/wallet/transactions/${userId}?limit=100`));
    expect(adminTx.items.some((t: { type: string }) => t.type === 'bet')).toBe(true);
    expect(adminTx.items.some((t: { type: string }) => t.type === 'win')).toBe(true);
    expect(adminTx.items.some((t: { type: string }) => t.type === 'loss')).toBe(true);
  });
});

describe('Auto-withdrawal: single-shot gates (appGated - fiatThreshold 200)', () => {
  it('auto-completes a fiat withdrawal under threshold, with a KYC-verified untagged player', async () => {
    const email = `auto-ok-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, playerId);

    await client.post('/wallet/deposit', { amount: 500, currency: 'USD' });
    const res = await client.post('/wallet/withdraw', { amount: 50, currency: 'USD' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('completed');

    const balance = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balance).toBe(450);

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
        threshold: 200,
        thresholdSource: 'global',
        kycStatus: 'verified',
        riskTagsEvaluated: [],
      });
    });
  });

  it('stays pending when KYC is not verified/manually_overridden, even though kyc.gateWithdrawals is off', async () => {
    const email = `auto-kyc-pending-${randomUUID()}@e2e.test`;
    const { client } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    // No verifyKyc() call - player stays at the default kycStatus 'pending'.

    await client.post('/wallet/deposit', { amount: 300, currency: 'USD' });
    const res = await client.post('/wallet/withdraw', { amount: 50, currency: 'USD' });
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
    const { client, playerId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, playerId);
    await assignTag(admin, playerId, 'high_risk');

    await client.post('/wallet/deposit', { amount: 300, currency: 'USD' });
    const res = await client.post('/wallet/withdraw', { amount: 50, currency: 'USD' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('stays pending when the amount exceeds the resolved threshold', async () => {
    const email = `auto-over-threshold-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, playerId);

    await client.post('/wallet/deposit', { amount: 500, currency: 'USD' });
    const res = await client.post('/wallet/withdraw', { amount: 250, currency: 'USD' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin);
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('never auto-approves the crypto rail, regardless of config', async () => {
    const email = `auto-crypto-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, playerId);

    await client.post('/wallet/deposit', { amount: 10, currency: 'BTC' });
    const res = await client.post('/wallet/withdraw', { amount: 1, currency: 'BTC' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('pending');

    const pending = await pendingWithdrawalIds(admin, 'BTC');
    expect(pending.has(body.transactionId)).toBe(true);
  });

  it('a lower per-player rule blocks what the global threshold would allow', async () => {
    const email = `auto-rule-blocks-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, playerId);

    const setRes = await admin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: 10,
      reason: 'watchlist - lower ceiling',
    });
    expect(setRes.status).toBe(200);

    await client.post('/wallet/deposit', { amount: 500, currency: 'USD' });
    // 40 is well under the global 200 threshold but over the per-player rule's 10.
    const res = await client.post('/wallet/withdraw', { amount: 40, currency: 'USD' });
    const body = await readJson(res);
    expect(body.status).toBe('pending');
  });

  it('a higher per-player rule allows what the global threshold would block', async () => {
    const email = `auto-rule-allows-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);
    await verifyKyc(admin, playerId);

    const setRes = await admin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: 300,
      reason: 'trusted long-standing player',
    });
    expect(setRes.status).toBe(200);

    await client.post('/wallet/deposit', { amount: 500, currency: 'USD' });
    // 250 exceeds the global 200 threshold but is under the per-player rule's 300.
    const res = await client.post('/wallet/withdraw', { amount: 250, currency: 'USD' });
    const body = await readJson(res);
    expect(body.status).toBe('completed');

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${body.transactionId}&action=wallet.withdrawal.auto_approved`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items[0].after).toMatchObject({
        threshold: 300,
        thresholdSource: 'per-player',
      });
    });
  });
});

describe('Auto-withdrawal: daily cap (appCapGated - dailyCapCount 1)', () => {
  it('auto-approves the first fiat withdrawal, then stays pending once the daily cap is used', async () => {
    const email = `auto-cap-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(appCapGated.app, email);
    const admin = await asAdmin(appCapGated.app);
    await verifyKyc(admin, playerId);

    await client.post('/wallet/deposit', { amount: 500, currency: 'USD' });

    const first = await readJson(
      await client.post('/wallet/withdraw', { amount: 30, currency: 'USD' }),
    );
    expect(first.status).toBe('completed');

    const second = await readJson(
      await client.post('/wallet/withdraw', { amount: 30, currency: 'USD' }),
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
    const { userId } = await registerAndMaterializePlayer(appDefault.app, email);
    const admin = await asAdmin(appDefault.app);

    const staffEmail = `rule-staff-${randomUUID()}@e2e.test`;
    const { client: staffClient, userId: staffUserId } = await registerAndMaterializePlayer(
      appDefault.app,
      staffEmail,
    );
    // `support` has other admin permissions but not `withdrawal:auto-rule`.
    await setRole(appDefault.container, staffUserId, 'support');

    // 401: no session at all.
    const anonSet = await appDefault.app.request(`/wallet/auto-withdrawal-rules/${userId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 100, reason: 'no session' }),
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
      threshold: 100,
      reason: 'should be denied',
    });
    expect(staffSet.status).toBe(403);
    const staffGet = await staffClient.get(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(staffGet.status).toBe(403);
    const staffDel = await staffClient.del(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(staffDel.status).toBe(403);

    // Admin: full round trip + audit trail on set and delete.
    const setRes = await admin.put(`/wallet/auto-withdrawal-rules/${userId}`, {
      threshold: 150,
      reason: 'admin round trip',
    });
    expect(setRes.status).toBe(200);
    const rule = await readJson(setRes);
    expect(rule).toMatchObject({ userId, threshold: 150, reason: 'admin round trip' });

    const getRes = await admin.get(`/wallet/auto-withdrawal-rules/${userId}`);
    expect(getRes.status).toBe(200);
    expect(await readJson(getRes)).toMatchObject({ threshold: 150 });

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${userId}&action=wallet.auto_withdrawal_rule.set`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.items[0].after).toMatchObject({
        threshold: 150,
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
    const { client } = await registerAndMaterializePlayer(appDefault.app, email);
    const admin = await asAdmin(appDefault.app);

    await client.post('/wallet/deposit', { amount: 300, currency: 'USD' });

    const w1 = await readJson(
      await client.post('/wallet/withdraw', { amount: 60, currency: 'USD' }),
    );
    expect(w1.status).toBe('pending');
    const balanceAfterHold = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balanceAfterHold).toBe(240);

    const approveRes = await admin.post(`/wallet/withdrawals/${w1.transactionId}/approve`, {
      withdrawalId: w1.transactionId,
    });
    expect(approveRes.status).toBe(200);
    expect((await readJson(approveRes)).status).toBe('completed');

    const w2 = await readJson(
      await client.post('/wallet/withdraw', { amount: 40, currency: 'USD' }),
    );
    expect(w2.status).toBe('pending');
    const balanceAfterSecondHold = (await readJson(await client.get('/wallet/balance'))).balance;
    expect(balanceAfterSecondHold).toBe(200); // 240 - 40

    const rejectRes = await admin.post(`/wallet/withdrawals/${w2.transactionId}/reject`, {
      withdrawalId: w2.transactionId,
      reason: 'qa regression check',
    });
    expect(rejectRes.status).toBe(200);
    expect((await readJson(rejectRes)).status).toBe('rejected');

    const balanceAfterReject = (await readJson(await client.get('/wallet/balance'))).balance;
    // Held funds are returned on reject.
    expect(balanceAfterReject).toBe(240);
  });
});
