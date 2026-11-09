import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { WAGER_TRACKING, WALLET_COMMANDS } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { auditLog } from '@openora/core/audit/schema';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import {
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakMilestoneGrant,
} from '@openora/core/promo/schema/gamification';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

const JOB_WAIT = { timeout: 15000, interval: 100 };
const DAY_MS = 86_400_000;
const CONFIG_PATH = '/backoffice/promo/streaks/config';
const CONFIG_ACTION = 'promo.streak_config.set';

const CONFIG = {
  enabled: true,
  dailyMinWager: '10',
  eligibleProducts: [],
  rakebackMilestones: [],
  fixedRewards: [{ day: 1, amount: '5', rolloverMultiplier: '10', claimExpiryDays: 7 }],
};

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let bonusAdmin: TestClient;
let bonusAdminId: string;
let support: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

async function adminWithRole(roleKey: string) {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `streak-staff-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, roleKey));
  if (!role) {
    throw new Error(`no seeded ${roleKey} role`);
  }
  await drizzle().insert(adminRoleAssignment).values({ userId, roleId: role.id });
  return { client, userId };
}

const qualify = (userId: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USD',
      amount: '10',
      weightedAmount: '10',
      realAmount: '10',
      context: { provider: 'aggregator', product: 'casino' },
    }),
  );

const bonusesFor = (userId: string) =>
  drizzle()
    .select()
    .from(promoGrant)
    .where(and(eq(promoGrant.userId, userId), eq(promoGrant.source, 'streak')));

const streakOf = async (client: TestClient) => readJson(await client.get('/promo/streaks'));

const configAudits = () =>
  drizzle().select().from(auditLog).where(eq(auditLog.action, CONFIG_ACTION));

async function playerWithWaitingReward() {
  const player = await registerAndMaterializePlayer(app, {
    email: `streak-claim-${randomUUID()}@example.test`,
  });
  await qualify(player.userId);
  const { fixedRewards } = await streakOf(player.client);
  expect(fixedRewards).toEqual([expect.objectContaining({ day: 1, state: 'claimable' })]);
  return { ...player, milestoneGrantId: fixedRewards[0].grantId as string };
}

async function fundedPlayer() {
  const player = await registerAndMaterializePlayer(app, {
    email: `streak-bet-${randomUUID()}@example.test`,
  });
  const res = await player.client.post('/wallet/deposit', {
    amount: '100',
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return player;
}

const betOf = (userId: string, amount: string, round: string, ref = `bet-${round}`) =>
  drizzle().transaction((tx) =>
    app.container.get(WALLET_COMMANDS).debit(tx, {
      userId,
      amount,
      type: 'bet',
      currency: 'USD',
      context: { provider: 'aggregator', product: 'casino' },
      providerRef: { providerName: 'aggregator', providerRefId: ref, externalRoundId: round },
    }),
  );

const reverseBet = (userId: string, amount: string, round: string) =>
  drizzle().transaction((tx) =>
    app.container.get(WALLET_COMMANDS).credit(tx, {
      userId,
      amount,
      currency: 'USD',
      type: 'bet_reversal',
      providerRef: {
        providerName: 'aggregator',
        providerRefId: `reversal-${round}`,
        externalRoundId: round,
      },
    }),
  );

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
  const staff = await adminWithRole('bonus-promotions');
  bonusAdmin = staff.client;
  bonusAdminId = staff.userId;
  support = (await adminWithRole('customer-support-agent')).client;
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('before the streak is configured', () => {
  it('answers a disabled streak rather than an error', async () => {
    const { client } = await registerAndMaterializePlayer(app, {
      email: `streak-unset-${randomUUID()}@example.test`,
    });

    const res = await client.get('/promo/streaks');

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      enabled: false,
      current: 0,
      activeRate: null,
      fixedRewards: [],
    });
  });
});

describe('an operator configuring the streak', () => {
  it('saves the config, reads it back and audits who saved it', async () => {
    const auditedBefore = (await configAudits()).length;

    const res = await bonusAdmin.put(CONFIG_PATH, CONFIG);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(CONFIG);
    expect(await readJson(await bonusAdmin.get(CONFIG_PATH))).toMatchObject({
      enabled: true,
      fixedRewards: [expect.objectContaining({ day: 1, amount: '5' })],
    });
    const audits = await configAudits();
    expect(audits).toHaveLength(auditedBefore + 1);
    expect(audits.at(-1)).toMatchObject({
      actorType: 'admin',
      actorId: bonusAdminId,
      after: expect.objectContaining({ enabled: true }),
    });
    expect(audits.at(-1)?.createdAt).toBeInstanceOf(Date);
  });

  it.each([
    ['a day beyond 35', { fixedRewards: [{ ...CONFIG.fixedRewards[0], day: 36 }] }],
    [
      'days out of order',
      {
        rakebackMilestones: [
          { day: 5, unrankedRatePercent: '1', rankedUpliftPercent: '1' },
          { day: 2, unrankedRatePercent: '1', rankedUpliftPercent: '1' },
        ],
      },
    ],
    ['a zero daily minimum', { dailyMinWager: '0' }],
    ['a zero claim expiry', { fixedRewards: [{ ...CONFIG.fixedRewards[0], claimExpiryDays: 0 }] }],
    [
      'a negative rate',
      { rakebackMilestones: [{ day: 1, unrankedRatePercent: '-1', rankedUpliftPercent: '0' }] },
    ],
  ])('refuses %s and saves nothing', async (_label, patch) => {
    await bonusAdmin.put(CONFIG_PATH, CONFIG);
    const auditedBefore = (await configAudits()).length;

    const res = await bonusAdmin.put(CONFIG_PATH, { ...CONFIG, ...patch });

    expect(res.status).toBe(400);
    expect(await readJson(await bonusAdmin.get(CONFIG_PATH))).toMatchObject({
      fixedRewards: [expect.objectContaining({ day: 1, claimExpiryDays: 7 })],
    });
    expect(await configAudits()).toHaveLength(auditedBefore);
  });

  it.each([
    [
      'a rollover with a thousands separator',
      { fixedRewards: [{ ...CONFIG.fixedRewards[0], rolloverMultiplier: '1,000' }] },
      'fixedRewards.0.rolloverMultiplier',
    ],
    [
      'a rate that is not a number',
      { rakebackMilestones: [{ day: 1, unrankedRatePercent: 'NaN', rankedUpliftPercent: '0' }] },
      'rakebackMilestones.0.unrankedRatePercent',
    ],
  ])('answers 400 naming the field for %s, not a server error', async (_label, patch, path) => {
    const res = await bonusAdmin.put(CONFIG_PATH, { ...CONFIG, ...patch });

    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { data: { issues: { path: (string | number)[] }[] } };
    expect(body.data.issues.map((issue) => issue.path.join('.'))).toContain(path);
  });

  it('reads back a config whose threshold was never set in dollars, without letting it be saved as is', async () => {
    await bonusAdmin.put(CONFIG_PATH, CONFIG);
    await drizzle().update(promoStreakConfig).set({ enabled: false, dailyMinWager: '0' });

    const read = await bonusAdmin.get(CONFIG_PATH);
    const resave = await bonusAdmin.put(CONFIG_PATH, await readJson(read));
    await bonusAdmin.put(CONFIG_PATH, CONFIG);

    expect(read.status).toBe(200);
    expect(resave.status).toBe(400);
  });

  it('lets a read-only admin look but not save, and refuses a player and an anonymous caller', async () => {
    await bonusAdmin.put(CONFIG_PATH, CONFIG);
    const auditedBefore = (await configAudits()).length;
    const { client } = await registerAndMaterializePlayer(app, {
      email: `streak-nosy-${randomUUID()}@example.test`,
    });

    expect((await support.get(CONFIG_PATH)).status).toBe(200);
    expect((await support.put(CONFIG_PATH, { ...CONFIG, enabled: false })).status).toBe(403);
    expect((await client.get(CONFIG_PATH)).status).toBe(403);
    expect((await client.put(CONFIG_PATH, { ...CONFIG, enabled: false })).status).toBe(403);
    expect((await app.app.request(CONFIG_PATH)).status).toBe(401);
    expect(await readJson(await bonusAdmin.get(CONFIG_PATH))).toMatchObject({ enabled: true });
    expect(await configAudits()).toHaveLength(auditedBefore);
  });
});

describe('a player claiming a streak fixed reward', () => {
  beforeAll(async () => {
    expect((await bonusAdmin.put(CONFIG_PATH, CONFIG)).status).toBe(200);
  });

  it('grants a bonus with the captured rollover, and a repeated claim is refused', async () => {
    const { client, userId, milestoneGrantId } = await playerWithWaitingReward();

    const first = await client.post('/promo/streaks/claim', { milestoneGrantId });
    const repeated = await client.post('/promo/streaks/claim', { milestoneGrantId });

    expect(first.status).toBe(200);
    expect(await readJson(first)).toEqual({ outcome: 'granted' });
    expect(repeated.status).toBe(404);
    const [bonus] = await bonusesFor(userId);
    expect(await bonusesFor(userId)).toHaveLength(1);
    expect(bonus).toMatchObject({
      currency: 'USD',
      grantedAmount: '5.000000000000000000',
      wageringRequired: '50.000000000000000000',
    });
    expect(bonus?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY_MS);
    expect(bonus?.expiresAt.getTime()).toBeLessThan(Date.now() + 7.1 * DAY_MS);
    expect((await streakOf(client)).fixedRewards).toEqual([
      expect.objectContaining({ day: 1, state: 'claimed' }),
    ]);
  });

  it('grants one bonus when claims race', async () => {
    const { client, userId, milestoneGrantId } = await playerWithWaitingReward();

    const results = await Promise.all(
      [1, 2, 3].map(() => client.post('/promo/streaks/claim', { milestoneGrantId })),
    );

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(await bonusesFor(userId)).toHaveLength(1);
  });

  it("refuses another player's reward and leaves it waiting for its owner", async () => {
    const owner = await playerWithWaitingReward();
    const { client: other } = await registerAndMaterializePlayer(app, {
      email: `streak-other-${randomUUID()}@example.test`,
    });

    const res = await other.post('/promo/streaks/claim', {
      milestoneGrantId: owner.milestoneGrantId,
    });

    expect(res.status).toBe(404);
    expect(await bonusesFor(owner.userId)).toEqual([]);
    expect((await streakOf(owner.client)).fixedRewards[0]).toMatchObject({
      grantId: owner.milestoneGrantId,
      state: 'claimable',
    });
  });

  it('refuses a claim once the window has closed, and shows the reward as expired', async () => {
    const { client, userId, milestoneGrantId } = await playerWithWaitingReward();
    await drizzle()
      .update(promoStreakMilestoneGrant)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(promoStreakMilestoneGrant.id, milestoneGrantId));

    const res = await client.post('/promo/streaks/claim', { milestoneGrantId });

    expect(res.status).toBe(404);
    expect(await bonusesFor(userId)).toEqual([]);
    expect((await streakOf(client)).fixedRewards[0]).toMatchObject({ day: 1, state: 'expired' });
  });

  it('pays the terms captured at unlock after the operator edits the config', async () => {
    const { client, userId, milestoneGrantId } = await playerWithWaitingReward();
    const edited = await bonusAdmin.put(CONFIG_PATH, {
      ...CONFIG,
      fixedRewards: [{ day: 1, amount: '99', rolloverMultiplier: '30', claimExpiryDays: 1 }],
    });
    expect(edited.status).toBe(200);

    const res = await client.post('/promo/streaks/claim', { milestoneGrantId });
    await bonusAdmin.put(CONFIG_PATH, CONFIG);

    expect(res.status).toBe(200);
    expect(await bonusesFor(userId)).toEqual([
      expect.objectContaining({
        grantedAmount: '5.000000000000000000',
        wageringRequired: '50.000000000000000000',
      }),
    ]);
  });

  it('stays claimable after the operator switches the streak off', async () => {
    const { client, userId, milestoneGrantId } = await playerWithWaitingReward();
    expect((await bonusAdmin.put(CONFIG_PATH, { ...CONFIG, enabled: false })).status).toBe(200);

    const state = await streakOf(client);
    const res = await client.post('/promo/streaks/claim', { milestoneGrantId });
    await bonusAdmin.put(CONFIG_PATH, CONFIG);

    expect(state).toMatchObject({ enabled: false, current: 0 });
    expect(state.fixedRewards[0]).toMatchObject({ state: 'claimable' });
    expect(res.status).toBe(200);
    expect(await bonusesFor(userId)).toHaveLength(1);
  });

  it('rejects a claim from an anonymous caller', async () => {
    const res = await app.app.request('/promo/streaks/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milestoneGrantId: randomUUID() }),
    });

    expect(res.status).toBe(401);
  });
});

describe('a streak day through real wallet bets', () => {
  beforeAll(async () => {
    expect((await bonusAdmin.put(CONFIG_PATH, CONFIG)).status).toBe(200);
  });

  it('counts a bet once even when the provider replays it', async () => {
    const { client, userId } = await fundedPlayer();

    await betOf(userId, '10', 'round-1', 'bet-ref-1');
    await betOf(userId, '10', 'round-1', 'bet-ref-1');

    expect(await streakOf(client)).toMatchObject({
      current: 1,
      todayWagered: '10.000000000000000000',
    });
  });

  it('undoes the day, and the reward it unlocked, when the provider rolls the bet back', async () => {
    const { client, userId } = await fundedPlayer();
    await betOf(userId, '10', 'round-2');
    expect((await streakOf(client)).fixedRewards[0]).toMatchObject({ state: 'claimable' });

    await reverseBet(userId, '10', 'round-2');

    const state = await streakOf(client);
    expect(state).toMatchObject({ current: 0, todayWagered: '0.000000000000000000' });
    expect(state.fixedRewards[0]).toMatchObject({ state: 'locked', grantId: null });
  });

  it('unlocks the reward once for a player whose streak is reached again', async () => {
    const { client, userId } = await fundedPlayer();
    await betOf(userId, '10', 'round-3');
    const first = (await streakOf(client)).fixedRewards[0];
    await drizzle()
      .update(promoPlayerStreak)
      .set({
        current: 0,
        lastQualifyingDay: new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10),
      })
      .where(eq(promoPlayerStreak.userId, userId));

    await betOf(userId, '10', 'round-4');

    expect((await streakOf(client)).fixedRewards[0]).toEqual(first);
  });
});

const forfeitAudit = async (milestoneGrantId: string) =>
  (
    await readJson(
      await admin.get(
        `/audit/logs?resourceId=${milestoneGrantId}&action=promo.streak.milestone.forfeited`,
      ),
    )
  ).items;

const outcomeOf = async (milestoneGrantId: string) => {
  const [row] = await drizzle()
    .select({ outcome: promoStreakMilestoneGrant.outcome })
    .from(promoStreakMilestoneGrant)
    .where(eq(promoStreakMilestoneGrant.id, milestoneGrantId));
  return row?.outcome;
};

describe('a responsible-gambling block forfeiting unclaimed streak rewards', () => {
  beforeAll(async () => {
    expect((await bonusAdmin.put(CONFIG_PATH, CONFIG)).status).toBe(200);
  });

  it('forfeits on an admin cooling-off and names the admin on the audit row', async () => {
    const { userId, milestoneGrantId } = await playerWithWaitingReward();
    const [adminUser] = await drizzle()
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, 'admin@oss.dev'));

    const res = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'player requested a break',
    });
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await forfeitAudit(milestoneGrantId)).toEqual([
        expect.objectContaining({ actorType: 'admin', actorId: adminUser?.id }),
      ]);
    }, JOB_WAIT);
    expect(await outcomeOf(milestoneGrantId)).toBe('restricted');
    expect(await bonusesFor(userId)).toEqual([]);
  });

  it('records the system, not an admin, for a rule-triggered self-exclusion', async () => {
    const { userId, milestoneGrantId } = await playerWithWaitingReward();

    app.container.get(EVENT_BUS).emit('rg.self_exclusion.activated', {
      userId,
      playerId: null,
      exclusionId: randomUUID(),
      isPermanent: true,
      durationMonths: null,
      expiresAt: null,
      initiatedBy: 'system',
      actorId: randomUUID(),
      reason: 'rg rule triggered',
    });

    await vi.waitFor(async () => {
      expect(await forfeitAudit(milestoneGrantId)).toEqual([
        expect.objectContaining({ actorType: 'system', actorId: null }),
      ]);
    }, JOB_WAIT);
    expect(await outcomeOf(milestoneGrantId)).toBe('restricted');
  });

  it('refuses the claim afterwards, so nothing is restored when the block ends', async () => {
    const { client, userId, milestoneGrantId } = await playerWithWaitingReward();
    app.container.get(EVENT_BUS).emit('rg.self_exclusion.activated', {
      userId,
      playerId: null,
      exclusionId: randomUUID(),
      isPermanent: false,
      durationMonths: 1,
      expiresAt: null,
      initiatedBy: 'system',
      actorId: randomUUID(),
      reason: 'rg rule triggered',
    });
    await vi.waitFor(async () => {
      expect(await outcomeOf(milestoneGrantId)).toBe('restricted');
    }, JOB_WAIT);

    const res = await client.post('/promo/streaks/claim', { milestoneGrantId });

    expect(res.status).toBe(404);
    expect(await bonusesFor(userId)).toEqual([]);
  });
});
