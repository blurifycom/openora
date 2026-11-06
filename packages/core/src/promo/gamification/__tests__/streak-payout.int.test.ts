import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, mock } from '../../../testing/mock.js';
import type {
  BonusGrantCommands,
  ExchangeRateReader,
  PlayEligibilityPort,
  WalletReader,
} from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import {
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
} from '../schema/index.js';
import { StreakService } from '../service/streak.service.js';
import {
  StreakMilestoneNotClaimableError,
  StreakPayoutService,
  type StreakMilestoneReached,
} from '../service/streak-payout.service.js';
import { PayoutRateUnavailableError } from '../shared/payout-currency.js';

let db: TestDb;
const grant = vi.fn<BonusGrantCommands['grant']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const convert = vi.fn<ExchangeRateReader['convert']>();
const getBalances = vi.fn<WalletReader['getBalances']>();
const audit = makeAuditWriter();
const payoutLogger = { error: vi.fn() };

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const service = () =>
  new StreakPayoutService({
    drizzle: db.drizzle,
    grants: mock<BonusGrantCommands>({ grant }),
    eligibility: mock<PlayEligibilityPort>({ isRestricted }),
    rates: mock<ExchangeRateReader>({ convert }),
    walletReader: mock<WalletReader>({ getBalances }),
    audit,
    logger: payoutLogger,
  });

const announceReached = async () => {
  const announced: StreakMilestoneReached[] = [];
  await service().announceReached((reached) => announced.push(reached));
  return announced;
};

const logger = { warn: vi.fn() };

const yesterday = () => new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);

type Owed = {
  amount: string;
  rolloverMultiplier: string;
  claimExpiryDays: number;
  expiresAt: Date;
  reachedAt: Date;
};

const owe = async (userId: string, day: number, overrides: Partial<Owed> = {}) => {
  const [row] = await db.drizzle.db
    .insert(promoStreakMilestoneGrant)
    .values({
      userId,
      day,
      amount: '10',
      rolloverMultiplier: '5',
      claimExpiryDays: 7,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      ...overrides,
    })
    .returning({ id: promoStreakMilestoneGrant.id });
  return row?.id ?? '';
};

const rewardRow = async (id: string) => {
  const [row] = await db.drizzle.db
    .select({
      settledAt: promoStreakMilestoneGrant.settledAt,
      outcome: promoStreakMilestoneGrant.outcome,
      announcedAt: promoStreakMilestoneGrant.announcedAt,
    })
    .from(promoStreakMilestoneGrant)
    .where(eq(promoStreakMilestoneGrant.id, id));
  return row;
};

const playsIn = (activeCurrency: string) =>
  getBalances.mockResolvedValue({ activeCurrency, balances: [] });

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  isRestricted.mockResolvedValue(false);
  grant.mockImplementation(async () => ({ ok: true, created: true, grantId: randomUUID() }));
  playsIn('USD');
  await db.drizzle.db.delete(promoStreakMilestoneGrant);
  await db.drizzle.db.delete(promoStreakDailyWager);
  await db.drizzle.db.delete(promoPlayerStreak);
  await db.drizzle.db.delete(promoStreakConfig);
  await db.drizzle.db.insert(promoStreakConfig).values({
    enabled: true,
    dailyMinWager: '1',
    eligibleProducts: [],
    rakebackMilestones: [],
    fixedRewards: [{ day: 3, amount: '10', rolloverMultiplier: '5', claimExpiryDays: 7 }],
  });
});

describe('claiming a streak reward', () => {
  it('grants the bonus captured at unlock, with its rollover and a window as long as the claim expiry', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3, { rolloverMultiplier: '30', claimExpiryDays: 14 });

    const claimed = await service().claim(userId, id);

    expect(claimed.outcome).toBe('granted');
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant.mock.calls[0]?.[1]).toMatchObject({
      userId,
      currency: 'USD',
      amount: '10.000000000000000000',
      source: 'streak',
      actor: { type: 'system' },
      terms: { wageringMultiplier: '30.000000000000000000', expiryDays: 14 },
      sourceRef: expect.stringMatching(new RegExp(`^streak-milestone:${id}:\\d+:0$`)),
    });
    expect(claimed.granted).toEqual([
      expect.objectContaining({ userId, source: 'streak', wageringRequired: expect.any(String) }),
    ]);
    await expect(rewardRow(id)).resolves.toMatchObject({ outcome: 'granted' });
  });

  it('requires the wagering that the captured rollover asks for', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3, { amount: '10', rolloverMultiplier: '2.5' });

    const { granted } = await service().claim(userId, id);

    expect(granted[0]?.wageringRequired).toBe('25.000000000000000000');
  });

  it('is unaffected by a config edit made after the reward was unlocked', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    await db.drizzle.db.update(promoStreakConfig).set({
      fixedRewards: [{ day: 3, amount: '999', rolloverMultiplier: '99', claimExpiryDays: 1 }],
    });

    await service().claim(userId, id);

    expect(grant.mock.calls[0]?.[1]).toMatchObject({
      amount: '10.000000000000000000',
      terms: { wageringMultiplier: '5.000000000000000000', expiryDays: 7 },
    });
  });

  it('still pays once the streak is disabled, or its config removed', async () => {
    const disabled = randomUUID();
    const removed = randomUUID();
    const disabledId = await owe(disabled, 3);
    const removedId = await owe(removed, 4);

    await db.drizzle.db.update(promoStreakConfig).set({ enabled: false });
    await expect(service().claim(disabled, disabledId)).resolves.toMatchObject({
      outcome: 'granted',
    });
    await db.drizzle.db.delete(promoStreakConfig);
    await expect(service().claim(removed, removedId)).resolves.toMatchObject({
      outcome: 'granted',
    });
  });

  it('pays the reward unlocked by a real qualifying bet', async () => {
    const userId = randomUUID();
    const streaks = new StreakService(db.drizzle, mock<ExchangeRateReader>({ convert }), logger);
    await db.drizzle.db
      .insert(promoPlayerStreak)
      .values({ userId, current: 2, best: 2, lastQualifyingDay: yesterday() });
    await db.drizzle.db.transaction((tx) =>
      streaks.recordWager(tx, {
        userId,
        currency: 'USD',
        amount: '1',
        weightedAmount: '1',
        realAmount: '1',
        context: { provider: 'aggregator', product: 'casino' },
      }),
    );
    const [unlocked] = (await streaks.getForPlayer(userId)).fixedRewards;

    await expect(service().claim(userId, unlocked?.grantId ?? '')).resolves.toMatchObject({
      outcome: 'granted',
    });

    expect(grant.mock.calls[0]?.[1]).toMatchObject({
      amount: '10.000000000000000000',
      terms: { wageringMultiplier: '5.000000000000000000', expiryDays: 7 },
    });
  });

  it('refuses to settle a claim whose bonus was already granted, and leaves it waiting', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    grant.mockResolvedValue({ ok: true, created: false, grantId: randomUUID() });

    await expect(service().claim(userId, id)).rejects.toThrow(/already granted/);

    await expect(rewardRow(id)).resolves.toMatchObject({ settledAt: null });
  });

  it('leaves the reward waiting when the bonus engine refuses the grant', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    grant.mockResolvedValue({ ok: false, reason: 'ineligible' });

    await expect(service().claim(userId, id)).rejects.toThrow(/grant refused/);

    await expect(rewardRow(id)).resolves.toMatchObject({ settledAt: null });
  });

  it('audits the claim with the grant it created, in the claim transaction', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    const grantId = randomUUID();
    grant.mockResolvedValue({ ok: true, created: true, grantId });

    await service().claim(userId, id);

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      actorType: 'player',
      actorId: userId,
      action: 'promo.streak.milestone.claimed',
      resourceType: 'promo_streak_milestone_grant',
      resourceId: id,
      before: { settledAt: null, outcome: null },
      after: { userId, day: 3, outcome: 'granted', grantIds: [grantId] },
    });
  });

  it('writes no claim audit row when the claim is refused', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await expect(service().claim(randomUUID(), id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );

    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('pays once: a second claim of the same reward is refused and grants nothing', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await service().claim(userId, id);

    await expect(service().claim(userId, id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('pays once when two claims race', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const results = await Promise.allSettled([
      service().claim(userId, id),
      service().claim(userId, id),
      service().claim(userId, id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("refuses a claim of another player's reward and leaves it waiting for its owner", async () => {
    const owner = randomUUID();
    const id = await owe(owner, 3);

    await expect(service().claim(randomUUID(), id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );

    expect(grant).not.toHaveBeenCalled();
    await expect(rewardRow(id)).resolves.toMatchObject({ settledAt: null });
  });

  it('refuses a row that carries no captured terms, which can never be claimed', async () => {
    const userId = randomUUID();
    const [row] = await db.drizzle.db
      .insert(promoStreakMilestoneGrant)
      .values({ userId, day: 3 })
      .returning({ id: promoStreakMilestoneGrant.id });

    await expect(service().claim(userId, row?.id ?? '')).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );
    expect(grant).not.toHaveBeenCalled();
  });

  it('gives nothing to a player under a responsible-gambling restriction', async () => {
    isRestricted.mockResolvedValue(true);
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const claimed = await service().claim(userId, id);

    expect(claimed).toEqual({ outcome: 'restricted', granted: [] });
    expect(grant).not.toHaveBeenCalled();
    expect(audit.recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      action: 'promo.streak.milestone.claimed',
      after: { outcome: 'restricted', grantIds: [] },
    });
    await expect(rewardRow(id)).resolves.toMatchObject({ outcome: 'restricted' });
  });
});

describe('the claim window', () => {
  it('accepts a claim a minute before the reward expires', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3, { expiresAt: new Date(Date.now() + MINUTE_MS) });

    await expect(service().claim(userId, id)).resolves.toMatchObject({ outcome: 'granted' });
  });

  it('refuses a claim a minute after the reward expired, granting nothing', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3, { expiresAt: new Date(Date.now() - MINUTE_MS) });

    await expect(service().claim(userId, id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );

    expect(grant).not.toHaveBeenCalled();
    await expect(rewardRow(id)).resolves.toMatchObject({ settledAt: null, outcome: null });
  });

  it('refuses a claim of a reward the sweep already expired', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3, { expiresAt: new Date(Date.now() - MINUTE_MS) });
    await service().expireDue(new Date());

    await expect(service().claim(userId, id)).rejects.toBeInstanceOf(
      StreakMilestoneNotClaimableError,
    );
  });
});

describe("granting the bonus in the player's active currency", () => {
  it('converts the dollar amount into the currency the player plays in', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    playsIn('USDT');
    convert.mockResolvedValue('9.9');

    const { granted } = await service().claim(userId, id);

    expect(convert).toHaveBeenCalledWith('10.000000000000000000', 'USD', 'USDT', expect.anything());
    expect(grant.mock.calls[0]?.[1]).toMatchObject({ userId, currency: 'USDT', amount: '9.9' });
    expect(granted).toEqual([
      expect.objectContaining({
        currency: 'USDT',
        grantedAmount: '9.9',
        wageringRequired: expect.any(String),
      }),
    ]);
  });

  it('grants unconverted when the player already plays in dollars', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await service().claim(userId, id);

    expect(convert).not.toHaveBeenCalled();
    expect(grant.mock.calls[0]?.[1]).toMatchObject({ currency: 'USD' });
  });

  it('grants nothing and leaves the reward claimable when no rate is available', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    playsIn('USDT');
    convert.mockResolvedValue(null);

    await expect(service().claim(userId, id)).rejects.toBeInstanceOf(PayoutRateUnavailableError);

    expect(grant).not.toHaveBeenCalled();
    await expect(rewardRow(id)).resolves.toMatchObject({ settledAt: null, outcome: null });
    expect(audit.recordInTransaction).not.toHaveBeenCalled();

    convert.mockResolvedValue('9.9');
    await expect(service().claim(userId, id)).resolves.toMatchObject({ outcome: 'granted' });
  });
});

describe('announcing a reward waiting to be claimed', () => {
  it('announces each unclaimed reward once', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);

    const first = await announceReached();
    const second = await announceReached();

    expect(first).toEqual([{ userId, day: 3, grantId: null }]);
    expect(second).toEqual([]);
    expect((await rewardRow(id))?.announcedAt).toBeInstanceOf(Date);
  });

  it('does not invite a restricted player to claim, and settles the reward as restricted', async () => {
    isRestricted.mockResolvedValue(true);
    const userId = randomUUID();
    const id = await owe(userId, 3);

    await expect(announceReached()).resolves.toEqual([]);

    await expect(rewardRow(id)).resolves.toMatchObject({
      outcome: 'restricted',
      announcedAt: null,
    });
    expect(audit.recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      action: 'promo.streak.milestone.claimed',
      resourceId: id,
      after: { userId, day: 3, outcome: 'restricted' },
    });
  });

  it('does not announce a reward whose claim window has closed', async () => {
    const id = await owe(randomUUID(), 3, { expiresAt: new Date(Date.now() - MINUTE_MS) });

    await expect(announceReached()).resolves.toEqual([]);

    await expect(rewardRow(id)).resolves.toMatchObject({ announcedAt: null, settledAt: null });
  });

  it('announces a reward whose day the config no longer pays, since the player holds it', async () => {
    const userId = randomUUID();
    await owe(userId, 5);

    await expect(announceReached()).resolves.toEqual([{ userId, day: 5, grantId: null }]);
  });

  it('does not announce a reward already claimed', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3);
    await service().claim(userId, id);

    await expect(announceReached()).resolves.toEqual([]);
  });
});

describe('announcing a batch with a row that fails', () => {
  it('announces the rows that committed and leaves the failing one waiting for the next tick', async () => {
    const [first, failing, last] = [randomUUID(), randomUUID(), randomUUID()];
    await owe(first, 3);
    const failingId = await owe(failing, 3);
    const lastId = await owe(last, 7);
    isRestricted.mockImplementation(async (userId) => {
      if (userId === failing) {
        throw new Error('eligibility lookup failed');
      }
      return false;
    });

    const announced = await announceReached();

    expect(announced).toEqual(
      expect.arrayContaining([
        { userId: first, day: 3, grantId: null },
        { userId: last, day: 7, grantId: null },
      ]),
    );
    expect(announced).toHaveLength(2);
    expect(payoutLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ milestoneGrantId: failingId }),
      'streak milestone announcement failed',
    );
    await expect(rewardRow(failingId)).resolves.toMatchObject({
      settledAt: null,
      announcedAt: null,
    });
    expect((await rewardRow(lastId))?.announcedAt).toBeInstanceOf(Date);
  });

  it('announces the failed row once it succeeds on a later tick', async () => {
    const userId = randomUUID();
    await owe(userId, 3);
    isRestricted.mockRejectedValueOnce(new Error('eligibility lookup failed'));

    await expect(announceReached()).resolves.toEqual([]);
    await expect(announceReached()).resolves.toEqual([{ userId, day: 3, grantId: null }]);
  });
});

describe('a responsible-gambling block starting', () => {
  const block = (
    userId: string,
    actor: { id: string; isAdmin: boolean } | null = null,
    reason: 'self_exclusion' | 'cooling_off' = 'self_exclusion',
  ) => service().forfeitUnclaimed({ userId, reason, actor });

  it("settles the player's unclaimed rewards as restricted and leaves claimed ones alone", async () => {
    const userId = randomUUID();
    const claimed = await owe(userId, 3);
    await service().claim(userId, claimed);
    const waiting = await owe(userId, 7);
    const otherPlayers = await owe(randomUUID(), 3);

    await expect(block(userId)).resolves.toBe(1);

    await expect(rewardRow(claimed)).resolves.toMatchObject({ outcome: 'granted' });
    await expect(rewardRow(waiting)).resolves.toMatchObject({ outcome: 'restricted' });
    await expect(rewardRow(otherPlayers)).resolves.toMatchObject({ settledAt: null });
  });

  it.each(['self_exclusion', 'cooling_off'] as const)(
    'sends no invitation and restores nothing after a %s: the reward is lost for good',
    async (reason) => {
      const userId = randomUUID();
      const id = await owe(userId, 3);

      await block(userId, null, reason);

      await expect(announceReached()).resolves.toEqual([]);
      await expect(service().claim(userId, id)).rejects.toBeInstanceOf(
        StreakMilestoneNotClaimableError,
      );
      expect(grant).not.toHaveBeenCalled();
      await expect(rewardRow(id)).resolves.toMatchObject({ outcome: 'restricted' });
    },
  );

  it('writes one audit row per forfeited reward, in the forfeit transaction', async () => {
    const userId = randomUUID();
    const waiting = await owe(userId, 3);

    await block(userId);

    expect(audit.recordManyInTransaction).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        actorType: 'system',
        action: 'promo.streak.milestone.forfeited',
        resourceType: 'promo_streak_milestone_grant',
        resourceId: waiting,
        before: { settledAt: null, outcome: null },
        after: expect.objectContaining({
          userId,
          day: 3,
          outcome: 'restricted',
          reason: 'self_exclusion',
        }),
      }),
    ]);
    expect(audit.recordManyInTransaction.mock.calls[0]?.[1][0]).not.toHaveProperty('actorId');
  });

  it.each([
    { isAdmin: true, actorType: 'admin' },
    { isAdmin: false, actorType: 'player' },
  ])('names the $actorType who started the block as the actor', async ({ isAdmin, actorType }) => {
    const userId = randomUUID();
    await owe(userId, 3);
    const actorId = randomUUID();

    await block(userId, { id: actorId, isAdmin });

    expect(audit.recordManyInTransaction.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ actorType, actorId }),
    ]);
  });

  it('forfeits and audits nothing a second time when the job is retried', async () => {
    const userId = randomUUID();
    await owe(userId, 3);
    await owe(userId, 7);

    await expect(block(userId)).resolves.toBe(2);
    await expect(block(userId)).resolves.toBe(0);

    const entries = audit.recordManyInTransaction.mock.calls.flatMap(([, rows]) => rows);
    expect(entries).toHaveLength(2);
  });

  it('leaves the rewards waiting and writes no audit row when the audit write fails', async () => {
    const userId = randomUUID();
    const waiting = await owe(userId, 3);
    audit.recordManyInTransaction.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(block(userId)).rejects.toThrow(/audit unavailable/);

    await expect(rewardRow(waiting)).resolves.toMatchObject({ settledAt: null });
  });
});

describe('the expiry sweep', () => {
  const now = () => new Date();
  const lapsed = () => new Date(Date.now() - MINUTE_MS);

  it('settles an unclaimed reward past its window as expired, with an audit row', async () => {
    const userId = randomUUID();
    const reachedAt = new Date(Date.now() - 8 * DAY_MS);
    const id = await owe(userId, 3, { reachedAt, expiresAt: lapsed() });

    await expect(service().expireDue(now())).resolves.toBe(1);

    await expect(rewardRow(id)).resolves.toMatchObject({ outcome: 'expired' });
    expect((await rewardRow(id))?.settledAt).toBeInstanceOf(Date);
    expect(audit.recordManyInTransaction).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        actorType: 'system',
        action: 'promo.streak.milestone.expired',
        resourceType: 'promo_streak_milestone_grant',
        resourceId: id,
        before: { settledAt: null, outcome: null },
        after: expect.objectContaining({
          userId,
          day: 3,
          outcome: 'expired',
          reachedAt: reachedAt.toISOString(),
        }),
      }),
    ]);
  });

  it('writes one audit row per expired reward', async () => {
    await owe(randomUUID(), 3, { expiresAt: lapsed() });
    await owe(randomUUID(), 3, { expiresAt: lapsed() });
    await owe(randomUUID(), 7, { expiresAt: lapsed() });

    await expect(service().expireDue(now())).resolves.toBe(3);

    const entries = audit.recordManyInTransaction.mock.calls.flatMap(([, rows]) => rows);
    expect(entries).toHaveLength(3);
  });

  it('does nothing a second time: no new settlement, no new audit row', async () => {
    const id = await owe(randomUUID(), 3, { expiresAt: lapsed() });
    await service().expireDue(now());
    const settled = (await rewardRow(id))?.settledAt;
    audit.recordManyInTransaction.mockClear();

    await expect(service().expireDue(now())).resolves.toBe(0);

    expect((await rewardRow(id))?.settledAt).toEqual(settled);
    const entries = audit.recordManyInTransaction.mock.calls.flatMap(([, rows]) => rows);
    expect(entries).toEqual([]);
  });

  it('leaves a reward still inside its window, a claimed one and a forfeited one alone', async () => {
    const waiting = await owe(randomUUID(), 3);
    const claimedUser = randomUUID();
    const claimed = await owe(claimedUser, 3);
    await service().claim(claimedUser, claimed);
    const forfeitedUser = randomUUID();
    const forfeited = await owe(forfeitedUser, 3, { expiresAt: lapsed() });
    await service().forfeitUnclaimed({ userId: forfeitedUser, reason: 'cooling_off', actor: null });

    await expect(service().expireDue(now())).resolves.toBe(0);

    await expect(rewardRow(waiting)).resolves.toMatchObject({ settledAt: null });
    await expect(rewardRow(claimed)).resolves.toMatchObject({ outcome: 'granted' });
    await expect(rewardRow(forfeited)).resolves.toMatchObject({ outcome: 'restricted' });
  });

  it('settles a reward with no captured expiry, which nothing can claim', async () => {
    const [row] = await db.drizzle.db
      .insert(promoStreakMilestoneGrant)
      .values({ userId: randomUUID(), day: 3 })
      .returning({ id: promoStreakMilestoneGrant.id });

    await expect(service().expireDue(now())).resolves.toBe(1);

    await expect(rewardRow(row?.id ?? '')).resolves.toMatchObject({ outcome: 'expired' });
  });

  it('expires nothing, and audits nothing, when the audit write fails', async () => {
    const id = await owe(randomUUID(), 3, { expiresAt: lapsed() });
    audit.recordManyInTransaction.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(service().expireDue(now())).rejects.toThrow(/audit unavailable/);

    await expect(rewardRow(id)).resolves.toMatchObject({ settledAt: null, outcome: null });
  });

  it('does not expire a reward a claim is settling at the same moment', async () => {
    const userId = randomUUID();
    const id = await owe(userId, 3, { expiresAt: new Date(Date.now() + 2000) });

    const claim = service().claim(userId, id);
    const sweep = service().expireDue(new Date(Date.now() + DAY_MS));
    await Promise.allSettled([claim, sweep]);

    const row = await rewardRow(id);
    expect(['granted', 'expired']).toContain(row?.outcome);
    expect(grant).toHaveBeenCalledTimes(row?.outcome === 'granted' ? 1 : 0);
  });
});
