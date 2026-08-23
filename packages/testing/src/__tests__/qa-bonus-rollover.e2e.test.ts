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

/**
 * Independent QA verification of bonus-rollover tracking (chat gift/rain funds land as
 * rollover-locked bonus balance, spendable immediately but not withdrawable until a
 * Super-Admin configurable multiplier's worth of wagering clears it, then auto-converts
 * to real balance with a notification). Driven through the REAL app (bootTestApp: real
 * Hono + oRPC + Postgres + Redis + real gift/gaming/notifications/audit modules) rather
 * than the implementer's own unit/router-level tests, which double AUDIT_WRITER/EventBus
 * and never exercise a real gift claim -> real wager -> real notification round trip.
 *
 * Rain is not separately driven here: `/rain`'s recipient resolution depends on
 * realtime presence (`transport.getOnlineUserIds`), which is orthogonal to this
 * feature's own logic - both `/gift` and `/rain` converge on the exact same
 * `WalletCommandsService.credit(tx, { type })` call bonus-rollover tracking added to
 * (`wallet-commands.service.ts`), so a real gift claim exercises the identical
 * bonus-credit-creation code path a rain credit would. `type: 'rain'` itself is
 * covered directly at the service level by the co-located dev tests.
 */

let db: TestDb;
let appMain: TestApp;
let superAdmin: TestClient;
let gameId: string;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

// Same two-stage AdminGuard bootstrap as the sibling auto-withdrawal-config QA suites:
// static user.role='admin' plus a real DB-backed super-admin role assignment.
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
  const res = await client.post('/wallet/deposit', { amount, currency });
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
  // A freshly-registered player has no `wallet` row at all - only `deposit()` lazily
  // provisions one (wallet.service.ts's deposit()). credit() does NOT auto-provision
  // it (by design: existing gift/rain scope, not bonus-rollover tracking's own), so a
  // claim against a wallet-less recipient 409s with "Recipient wallet is unavailable"
  // instead of crediting - discovered while writing this suite. Materialize the wallet the same
  // way a real player would before ever claiming a gift: deposit first. Idempotent to
  // call more than once per recipient (each call just adds another 1 unit).
  await claimer.post('/wallet/deposit', { amount: '1', currency: 'USD' });

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

async function rolloverStatus(client: TestClient) {
  const res = await client.get('/wallet/bonus-rollover/status');
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
  // QA-discovered gap (not a regression from this feature, filed separately):
  // @openora/testing's setupTestDb() migration list (packages/testing/src/db.ts) omits
  // chat-commands and social-transfers - both own a `migrate.ts` but neither is in
  // applyAllMigrations, so `chat_command_config`/`player_gift`/`player_rain` don't exist
  // yet on a fresh test db and any /gift or /rain e2e test 500s. Apply them directly
  // here so this suite can actually drive the real gift-claim flow it needs.
  await migrateChatCommands(db.url);
  await migrateSocialTransfers(db.url);
  const basePlugins = await loadExtensions();
  appMain = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });

  // QA-discovered bug, since fixed upstream in seed-demo-data.ts (its wipe-and-reseed
  // step now clears `wallet_bonus_credit` before `wallet`, since the FK between them has
  // no ON DELETE CASCADE). Kept here too as a belt-and-suspenders clear so this suite
  // stays robust to a future regression in that ordering.
  await appMain.container.get(DRIZZLE).db.delete(walletBonusCredit);

  await seedMinimal(appMain.container, { playerCount: 0 });
  // seedMinimal does not seed chat-command config (only IAM + tag + demo fixture) -
  // /gift and /rain 404 with CommandDisabledError without it, same as production boot.
  await seedChatCommands(appMain.container.get(DRIZZLE).db);
  // Deliberately NOT calling seedBonusRolloverConfig here for most of this file - the
  // singleton row starts genuinely absent, the same as an install that boots without
  // ever running the seed script. Probe #7 (missing-config fallback) depends on this.
  // This suite's apps share one physical test database across the whole
  // test:integration run (and across repeated local runs of this same file, since
  // setupTestDb() migrates idempotently but never drops), so delete any pre-existing
  // row a prior run may have left behind - same reasoning as the sibling
  // auto-withdrawal-config suite.
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
  // MUST clean up every wallet_bonus_credit row this file created: this suite shares
  // one physical Postgres database with every sibling e2e file in the same
  // test:integration run (fileParallelism: false), and - per the QA finding recorded
  // above beforeAll - any leftover wallet_bonus_credit row makes seedDemoData's
  // `db.delete(wallet)` throw a Postgres FK violation for the NEXT file that calls
  // seedMinimal(). Leaving rows behind here would silently break every e2e suite that
  // happens to run after this one.
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

    // No wallet_bonus_rollover_config row exists yet anywhere in this suite's fresh
    // app - proves the credit() path's 1x fallback (probe #7), not just that a prior
    // admin PATCH happened to leave the multiplier at 1.
    const giftId = await sendGift(sender, '40');
    const claimResult = await claimGift(recipient, giftId);
    expect(claimResult.claimedBy).toBe(recipientId);

    let status = await rolloverStatus(recipient);
    expect(status.credits).toHaveLength(1);
    const credit = status.credits[0]!;
    expect(credit).toMatchObject({ sourceType: 'gift', status: 'active' });
    expect(Number(credit.creditedAmount)).toBe(40);
    expect(Number(credit.rolloverMultiplier)).toBe(1); // fallback, no config row seeded
    expect(Number(credit.rolloverRequired)).toBe(40);
    expect(Number(credit.rolloverProgress)).toBe(0);

    // AC: usable for gameplay immediately - the gifted balance is already spendable.
    await bet(recipient, '25');
    status = await rolloverStatus(recipient);
    const midCredit = status.credits.find((c) => c.id === credit.id)!;
    expect(midCredit.status).toBe('active');
    expect(Number(midCredit.rolloverProgress)).toBe(25);

    // AC: cannot withdraw locked funds. Remaining balance is exactly 15 (40 - 25 bet),
    // and locked = 40 - 25 = 15, so withdrawable = 0 - any positive withdrawal is blocked.
    const blockedWithdraw = await recipient.post('/wallet/withdraw', {
      amount: '10',
      currency: 'USD',
    });
    expect(blockedWithdraw.status).toBe(409);
    const blockedBody = await readJson(blockedWithdraw);
    expect(String(blockedBody.message ?? blockedBody.error ?? '')).toMatch(/rollover|locked/i);

    // Final bet completes the rollover requirement exactly (25 + 15 = 40).
    await bet(recipient, '15');
    status = await rolloverStatus(recipient);
    const finalCredit = status.credits.find((c) => c.id === credit.id)!;
    expect(finalCredit.status).toBe('completed');
    expect(Number(finalCredit.rolloverProgress)).toBe(40);
    expect(finalCredit.completedAt).not.toBeNull();

    // AC: notification created on release. The completion event travels through a real
    // EventBus (Redis Streams under load), so the notifications subscriber may not have
    // processed it the instant startRound's HTTP response returns - poll rather than
    // asserting on the very next request.
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
      // The body interpolates the raw numeric(38,18) string verbatim (same established
      // convention as the sibling withdrawal.approved/rejected notifications in this
      // same plugin.ts, not something bonus-rollover tracking introduced) - match loosely on the amount.
      expect(releaseNotif!.body).toMatch(/40(\.0+)? USD/);
    });

    // AC: converts to withdrawable real balance automatically - a withdrawal that was
    // blocked mid-rollover now succeeds for the full remaining balance (0 after both
    // bets; deposit more so there's something concrete to withdraw and re-prove the
    // lock is actually gone, not just that the balance happens to be zero).
    await deposit(recipient, '5');
    const unlockedWithdraw = await recipient.post('/wallet/withdraw', {
      amount: '5',
      currency: 'USD',
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
    // Deliberately NOT assigning the super-admin adminRoleAssignment row - this is the
    // "coarse gate passes, granular RBAC does not" case the plan's permissions.ts
    // change is supposed to prevent from leaking through.

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

    // The bystander's own call returns THEIR OWN (empty) list - proving the route
    // resolves strictly from the caller's session (getUserId(context)) and there is no
    // request parameter (query/body) that could redirect it at ownerId's credits.
    const bystanderStatus = await rolloverStatus(bystander);
    expect(bystanderStatus.credits).toHaveLength(0);

    // Confirm a query-string userId override (a naive IDOR attempt) is silently
    // ignored, not honored.
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
    // Distinct idempotencyKey/gift row - createdAt ordering (asc) is what the waterfall
    // keys off, so give the two claims a moment apart rather than relying on
    // same-millisecond insert order.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const gift2 = await sendGift(sender, '50');
    await claimGift(recipient, gift2);

    let status = await rolloverStatus(recipient);
    expect(status.credits.filter((c) => c.status === 'active')).toHaveLength(2);

    // One 40-unit bet: fully drains+completes the 30-required credit, 10 leftover
    // cascades into the 50-required credit.
    await bet(recipient, '40');

    status = await rolloverStatus(recipient);
    const older = status.credits.find((c) => Number(c.creditedAmount) === 30)!;
    const newer = status.credits.find((c) => Number(c.creditedAmount) === 50)!;
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
    // Config row is still absent at this point in the suite (first-ever GET) - fails
    // closed with NotFound, matching the plan's documented GET behaviour.
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

    // A fresh gift claimed now picks up the new 3x multiplier.
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

    // Bump the multiplier again and confirm this just-created credit's own snapshot
    // does NOT retroactively change.
    await superAdmin.patch('/backoffice/wallet/bonus-rollover-config', { multiplier: '10' });
    const restatus = await rolloverStatus(recipient);
    const sameCredit = restatus.credits.find((c) => c.id === newCredit.id)!;
    expect(Number(sameCredit.rolloverMultiplier)).toBe(3);
    expect(Number(sameCredit.rolloverRequired)).toBe(30);

    // Reset to 1x so later describe blocks in this file that don't seed their own
    // wallet_bonus_rollover_config value get the expected 1x credits again.
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
    // Numeric compare, not exact string: the value reaching the audit write has
    // already round-tripped through Postgres numeric(38,18) (claimGift() passes the
    // DB-returned, already-normalized playerGift.amount into credit()), not the raw
    // "12" the API request body carried.
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
