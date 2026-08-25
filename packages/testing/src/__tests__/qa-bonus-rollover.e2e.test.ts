import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { walletBonusRolloverConfig, walletBonusCredit } from '@openora/core/wallet/schema';
import { seedChatCommands } from '@openora/core/engagement/seed/chat-commands';
import { migrate as migrateChatCommands } from '@openora/core/engagement/migrate/chat-commands';
import { migrate as migrateSocialTransfers } from '@openora/core/engagement/migrate/social-transfers';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let appMain: TestApp;
let superAdmin: TestClient;
let gameId: string;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function makeSuperAdmin(app: TestApp, email: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, { email });
  const drizzle = app.container.get(DRIZZLE).db;
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

async function deposit(client: TestClient, amount: string, currency = 'USD') {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency,
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

async function sendGift(sender: TestClient, amount: string) {
  const res = await sender.post('/chat-command/gift', {
    amount,
    roomId: '__global',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`postGift failed (${res.status}): ${await res.text()}`);
  }
  const body = await readJson(res);
  const giftId = body.metadata?.giftId as string;
  if (!giftId) {
    throw new Error(`postGift response had no metadata.giftId: ${JSON.stringify(body)}`);
  }
  return giftId;
}

async function claimGift(claimer: TestClient, giftId: string) {
  await claimer.post('/wallet/deposit', {
    amount: '1',
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });

  const res = await claimer.post(`/chat-command/gift/${giftId}/claim`);
  if (res.status !== 200) {
    throw new Error(`claimGift failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

async function bet(client: TestClient, amount: string) {
  const res = await client.post('/gaming/rounds/start', {
    gameId,
    currency: 'USD',
    betAmount: amount,
  });
  if (res.status !== 200) {
    throw new Error(`startRound failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

async function rolloverStatus(client: TestClient, status?: 'active' | 'completed') {
  const query = status ? `?status=${status}` : '';
  const res = await client.get(`/wallet/bonus-rollover/status${query}`);
  if (res.status !== 200) {
    throw new Error(`bonus-rollover/status failed (${res.status}): ${await res.text()}`);
  }
  return (await readJson(res)) as {
    credits: Array<{
      id: string;
      sourceType: string;
      creditedAmount: string;
      rolloverMultiplier: string;
      rolloverRequired: string;
      rolloverProgress: string;
      status: string;
      createdAt: string;
      completedAt: string | null;
    }>;
  };
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  await migrateChatCommands(db.url);
  await migrateSocialTransfers(db.url);
  const basePlugins = await loadExtensions();
  appMain = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });

  await appMain.container.get(DRIZZLE).db.delete(walletBonusCredit);

  await seedMinimal(appMain.container, { playerCount: 0 });
  await seedChatCommands(appMain.container.get(DRIZZLE).db);
  await appMain.container.get(DRIZZLE).db.delete(walletBonusRolloverConfig);

  const superAdminEmail = `bonus-rollover-super-admin-${randomUUID()}@e2e.test`;
  const created = await makeSuperAdmin(appMain, superAdminEmail);
  superAdmin = created.client;

  const [gameRow] = await appMain.container
    .get(DRIZZLE)
    .db.insert(game)
    .values({ name: 'Bonus Rollover QA Game', provider: 'mock', category: 'slots' })
    .returning();
  if (!gameRow) {
    throw new Error('failed to seed a game row');
  }
  gameId = gameRow.id;
}, 60_000);

afterAll(async () => {
  if (gameId) {
    await appMain.container.get(DRIZZLE).db.delete(gameRound).where(eq(gameRound.gameId, gameId));
    await appMain.container.get(DRIZZLE).db.delete(game).where(eq(game.id, gameId));
  }
  if (appMain) {
    await appMain.container.get(DRIZZLE).db.delete(walletBonusCredit);
    await appMain.container.get(DRIZZLE).db.delete(walletBonusRolloverConfig);
  }
  await appMain?.close();
  await db?.dispose();
});

describe('bonus-rollover AC end-to-end: gift -> bonus-locked balance -> wagering -> auto-release -> notification -> withdrawal', () => {
  it('walks the full lifecycle against the real app, with the status endpoint correct at every step (probes #1 and #7)', async () => {
    const senderEmail = `bf326-sender-${randomUUID()}@e2e.test`;
    const recipientEmail = `bf326-recipient-${randomUUID()}@e2e.test`;
    const { client: sender } = await registerAndMaterializePlayer(appMain, { email: senderEmail });
    const { client: recipient, userId: recipientId } = await registerAndMaterializePlayer(appMain, {
      email: recipientEmail,
    });
    await deposit(sender, '500');

    const giftId = await sendGift(sender, '40');
    const claimResult = await claimGift(recipient, giftId);
    expect(claimResult.claimedBy).toBe(recipientId);

    let status = await rolloverStatus(recipient);
    expect(status.credits).toHaveLength(1);
    const credit = status.credits[0]!;
    expect(credit).toMatchObject({ sourceType: 'gift', status: 'active' });
    expect(Number(credit.creditedAmount)).toBe(40);
    expect(Number(credit.rolloverMultiplier)).toBe(1);
    expect(Number(credit.rolloverRequired)).toBe(40);
    expect(Number(credit.rolloverProgress)).toBe(0);

    await bet(recipient, '25');
    status = await rolloverStatus(recipient);
    const midCredit = status.credits.find((c) => c.id === credit.id)!;
    expect(midCredit.status).toBe('active');
    expect(Number(midCredit.rolloverProgress)).toBe(25);

    const blockedWithdraw = await recipient.post('/wallet/withdraw', {
      amount: '10',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    });
    expect(blockedWithdraw.status).toBe(409);
    const blockedBody = await readJson(blockedWithdraw);
    expect(String(blockedBody.message ?? blockedBody.error ?? '')).toMatch(/rollover|locked/i);

    await bet(recipient, '15');
    status = await rolloverStatus(recipient, 'completed');
    const finalCredit = status.credits.find((c) => c.id === credit.id)!;
    expect(finalCredit.status).toBe('completed');
    expect(Number(finalCredit.rolloverProgress)).toBe(40);
    expect(finalCredit.completedAt).not.toBeNull();

    await vi.waitFor(async () => {
      const notifRes = await recipient.get('/notifications');
      expect(notifRes.status).toBe(200);
      const notifications = (await readJson(notifRes)) as Array<{
        type: string;
        title: string;
        body: string;
      }>;
      const releaseNotif = notifications.find((n) => n.type === 'wallet.bonus_rollover.completed');
      expect(
        releaseNotif,
        'expected a wallet.bonus_rollover.completed notification row',
      ).toBeDefined();
      expect(releaseNotif!.body).toMatch(/40(\.0+)? USD/);
    });

    await deposit(recipient, '5');
    const unlockedWithdraw = await recipient.post('/wallet/withdraw', {
      amount: '5',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    });
    expect(unlockedWithdraw.status).toBe(200);
    const unlockedBody = await readJson(unlockedWithdraw);
    expect(['pending', 'completed', 'processing']).toContain(unlockedBody.status);
  });
});

describe('bonus-rollover authz negatives (probe #2)', () => {
  it('a non-super-admin (plain player) is rejected on both backoffice bonus-rollover-config routes', async () => {
    const { client: plainPlayer } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-plain-${randomUUID()}@e2e.test`,
    });

    const getRes = await plainPlayer.get('/backoffice/wallet/bonus-rollover-config');
    expect(getRes.status).toBeGreaterThanOrEqual(401);
    expect(getRes.status).toBeLessThan(500);

    const patchRes = await plainPlayer.patch('/backoffice/wallet/bonus-rollover-config', {
      multiplier: '5',
    });
    expect(patchRes.status).toBeGreaterThanOrEqual(401);
    expect(patchRes.status).toBeLessThan(500);
  });

  it('a plain (non-super) admin is also rejected - the resource is super-admin-only', async () => {
    const { client: adminEmail, userId } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-plain-admin-${randomUUID()}@e2e.test`,
    });
    await appMain.container
      .get(DRIZZLE)
      .db.update(user)
      .set({ role: 'admin' })
      .where(eq(user.id, userId));
    const getRes = await adminEmail.get('/backoffice/wallet/bonus-rollover-config');
    expect(getRes.status).toBeGreaterThanOrEqual(401);
    expect(getRes.status).toBeLessThan(500);
  });

  it("a player's bonus-rollover status is scoped to their own session - there is no userId parameter to point at someone else's credits", async () => {
    const senderEmail = `bf326-scope-sender-${randomUUID()}@e2e.test`;
    const { client: sender } = await registerAndMaterializePlayer(appMain, { email: senderEmail });
    const { client: ownerClient, userId: ownerId } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-scope-owner-${randomUUID()}@e2e.test`,
    });
    const { client: bystander } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-scope-bystander-${randomUUID()}@e2e.test`,
    });
    await deposit(sender, '50');
    const giftId = await sendGift(sender, '20');
    await claimGift(ownerClient, giftId);

    const ownerStatus = await rolloverStatus(ownerClient);
    expect(ownerStatus.credits.some((c) => Number(c.creditedAmount) === 20)).toBe(true);

    const bystanderStatus = await rolloverStatus(bystander);
    expect(bystanderStatus.credits).toHaveLength(0);

    const idorAttempt = await bystander.get(`/wallet/bonus-rollover/status?userId=${ownerId}`);
    expect(idorAttempt.status).toBe(200);
    const idorBody = await readJson(idorAttempt);
    expect(idorBody.credits).toHaveLength(0);
  });
});

describe('bonus-rollover waterfall across multiple simultaneously-active credits (probe #3)', () => {
  it('a single bet drains the oldest active credit first and cascades the leftover into the next, through the real HTTP surface', async () => {
    const senderEmail = `bf326-waterfall-sender-${randomUUID()}@e2e.test`;
    const { client: sender } = await registerAndMaterializePlayer(appMain, { email: senderEmail });
    const { client: recipient } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-waterfall-recipient-${randomUUID()}@e2e.test`,
    });
    await deposit(sender, '500');

    const gift1 = await sendGift(sender, '30');
    await claimGift(recipient, gift1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const gift2 = await sendGift(sender, '50');
    await claimGift(recipient, gift2);

    const status = await rolloverStatus(recipient);
    expect(status.credits.filter((c) => c.status === 'active')).toHaveLength(2);

    await bet(recipient, '40');

    const completedStatus = await rolloverStatus(recipient, 'completed');
    const activeStatus = await rolloverStatus(recipient, 'active');
    const older = completedStatus.credits.find((c) => Number(c.creditedAmount) === 30)!;
    const newer = activeStatus.credits.find((c) => Number(c.creditedAmount) === 50)!;
    expect(older.status, 'the older (first-claimed) credit must be the one that completed').toBe(
      'completed',
    );
    expect(Number(older.rolloverProgress)).toBe(30);
    expect(newer.status).toBe('active');
    expect(Number(newer.rolloverProgress)).toBe(10);
  });
});

describe('bonus-rollover multiplier configurable by Super Admin, forward-only (probes covering the config route + no retroactive change)', () => {
  it('GET/PATCH are gated to super-admin, and a new multiplier only applies to credits created AFTER the change', async () => {
    const before = await superAdmin.get('/backoffice/wallet/bonus-rollover-config');
    expect(before.status).toBe(404);

    const setRes = await superAdmin.patch('/backoffice/wallet/bonus-rollover-config', {
      multiplier: '3',
    });
    expect(setRes.status).toBe(200);
    const setBody = await readJson(setRes);
    expect(Number(setBody.multiplier)).toBe(3);

    const getRes = await superAdmin.get('/backoffice/wallet/bonus-rollover-config');
    expect(getRes.status).toBe(200);
    expect(Number((await readJson(getRes)).multiplier)).toBe(3);

    const senderEmail = `bf326-multiplier-sender-${randomUUID()}@e2e.test`;
    const { client: sender } = await registerAndMaterializePlayer(appMain, { email: senderEmail });
    const { client: recipient } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-multiplier-recipient-${randomUUID()}@e2e.test`,
    });
    await deposit(sender, '100');
    const giftId = await sendGift(sender, '10');
    await claimGift(recipient, giftId);

    const status = await rolloverStatus(recipient);
    const newCredit = status.credits[0]!;
    expect(Number(newCredit.rolloverMultiplier)).toBe(3);
    expect(Number(newCredit.rolloverRequired)).toBe(30);

    await superAdmin.patch('/backoffice/wallet/bonus-rollover-config', { multiplier: '10' });
    const restatus = await rolloverStatus(recipient);
    const sameCredit = restatus.credits.find((c) => c.id === newCredit.id)!;
    expect(Number(sameCredit.rolloverMultiplier)).toBe(3);
    expect(Number(sameCredit.rolloverRequired)).toBe(30);

    await superAdmin.patch('/backoffice/wallet/bonus-rollover-config', { multiplier: '1' });
  });
});

describe('bonus-rollover audit trail (probe #5)', () => {
  it('wallet.bonus_credit.created, wallet.bonus_credit.completed, and the admin config change all produce audit rows with real before/after state', async () => {
    const senderEmail = `bf326-audit-sender-${randomUUID()}@e2e.test`;
    const { client: sender } = await registerAndMaterializePlayer(appMain, { email: senderEmail });
    const { client: recipient, userId: recipientId } = await registerAndMaterializePlayer(appMain, {
      email: `bf326-audit-recipient-${randomUUID()}@e2e.test`,
    });
    await deposit(sender, '100');
    const giftId = await sendGift(sender, '12');
    await claimGift(recipient, giftId);

    const createdAuditRes = await superAdmin.get(
      `/audit/logs?action=wallet.bonus_credit.created&resourceType=wallet_bonus_credit&limit=50`,
    );
    expect(createdAuditRes.status).toBe(200);
    const createdAudit = await readJson(createdAuditRes);
    const createdEntry = createdAudit.items.find(
      (it: { after: { userId?: string } }) => it.after && it.after.userId === recipientId,
    );
    expect(
      createdEntry,
      'expected a wallet.bonus_credit.created audit row for this recipient',
    ).toBeDefined();
    expect(createdEntry.after).toMatchObject({
      userId: recipientId,
      currency: 'USD',
      sourceType: 'gift',
    });
    expect(Number(createdEntry.after.creditedAmount)).toBe(12);
    expect(createdEntry.after.rolloverRequired).toBeDefined();
    expect(createdEntry.before).toBeNull();

    await bet(recipient, '12');

    const completedAuditRes = await superAdmin.get(
      `/audit/logs?action=wallet.bonus_credit.completed&resourceType=wallet_bonus_credit&limit=50`,
    );
    const completedAudit = await readJson(completedAuditRes);
    const completedEntry = completedAudit.items.find(
      (it: { after: { userId?: string; creditedAmount?: string } }) =>
        it.after && it.after.userId === recipientId && Number(it.after.creditedAmount) === 12,
    );
    expect(completedEntry, 'expected a wallet.bonus_credit.completed audit row').toBeDefined();
    expect(completedEntry.before).toMatchObject({ status: 'active' });
    expect(completedEntry.after).toMatchObject({ status: 'completed' });
    expect(completedEntry.after.rolloverProgress).toBe(completedEntry.after.rolloverRequired);

    const configAuditRes = await superAdmin.get(
      `/audit/logs?action=wallet.bonus_rollover_config.set&resourceType=bonus_rollover_config&limit=1`,
    );
    const configAudit = await readJson(configAuditRes);
    expect(configAudit.items.length).toBeGreaterThanOrEqual(1);
    const configEntry = configAudit.items[0];
    expect(configEntry.actorType).toBe('admin');
    expect(configEntry.after.multiplier).toBeDefined();
  });
});

describe('bonus-rollover config table stays clean between describe blocks', () => {
  it('sanity: exactly one wallet_bonus_rollover_config row exists (singleton upsert, not duplicate inserts)', async () => {
    const rows = await appMain.container.get(DRIZZLE).db.select().from(walletBonusRolloverConfig);
    expect(rows).toHaveLength(1);
  });
});
