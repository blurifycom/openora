import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { WagerContext, WagerProduct, WagerTrackingCommands } from '@openora/core/contracts';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry, promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantService } from '../service/grant.service.js';
import { WageringService } from '../service/wagering.service.js';

let db: TestDb;

const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('wager() with no attributed bonus grant', () => {
  it('still reports the bet to wager tracking at its full stake', async () => {
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => []) };
    const wagering = new WageringService(wagerTracking);
    const userId = randomUUID();

    const outcome = await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '25',
        fromBonus: '0',
        context: CASINO,
        providerName: 'dice',
        externalRoundId: randomUUID(),
      }),
    );

    expect(outcome).toMatchObject({ ok: true, grantId: null });
    expect(wagerTracking.recordWager).toHaveBeenCalledTimes(1);
    expect(wagerTracking.recordWager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, currency: 'USD', amount: '25', weightedAmount: '25' }),
    );
  });

  it('takes a rolled-back cash round back out of wager tracking', async () => {
    const wagerTracking: WagerTrackingCommands = {
      recordWager: vi.fn(async () => []),
      reverseWager: vi.fn(async () => {}),
    };
    const wagering = new WageringService(wagerTracking);
    const userId = randomUUID();
    const round = { providerName: 'dice', externalRoundId: randomUUID() };

    await db.drizzle.db.transaction(async (tx) => {
      await wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '25',
        fromBonus: '0',
        context: CASINO,
        ...round,
      });
      await wagering.settle(tx, {
        userId,
        currency: 'USD',
        amount: '25',
        kind: 'bet_reversal',
        ...round,
      });
    });

    expect(wagerTracking.recordWager).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ round }),
    );
    expect(wagerTracking.reverseWager).toHaveBeenCalledWith(expect.anything(), {
      userId,
      currency: 'USD',
      round,
      realAmount: '25',
    });
  });

  it('does not report a bet requesting bonus funds it has no grant for', async () => {
    const wagerTracking: WagerTrackingCommands = { recordWager: vi.fn(async () => []) };
    const wagering = new WageringService(wagerTracking);

    const outcome = await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId: randomUUID(),
        currency: 'USD',
        stake: '25',
        fromBonus: '10',
        context: CASINO,
        providerName: 'dice',
        externalRoundId: randomUUID(),
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: 'insufficient_bonus' });
    expect(wagerTracking.recordWager).not.toHaveBeenCalled();
  });
});

describe('wager() on a product the grant excludes from bonus funds', () => {
  const EXCLUDED = ['pvp', 'live-casino', 'sportsbook'] as const satisfies WagerProduct[];

  const grantFor = async (userId: string, excludedProducts?: WagerProduct[]) => {
    const profileId = findOneOrThrow(
      await db.drizzle.db
        .insert(promoWeightProfile)
        .values({ name: `profile-${randomUUID()}` })
        .returning(),
      new Error('seed profile: query returned no row'),
    ).id;
    await db.drizzle.db.insert(promoWeight).values({
      profileId,
      scope: 'default',
      scopeRef: null,
      contributionPercent: '100',
    });
    const outcome = await db.drizzle.db.transaction((tx) =>
      new GrantService(makeAuditWriter()).grant(tx, {
        userId,
        currency: 'USD',
        amount: '100',
        source: 'deposit',
        sourceRef: randomUUID(),
        actor: { type: 'system' },
        terms: {
          wageringMultiplier: '5',
          expiryDays: 30,
          weightProfileId: profileId,
          ...(excludedProducts ? { excludedProducts } : {}),
        },
      }),
    );
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }
    return outcome.grantId;
  };

  const bet = (userId: string, product: WagerProduct, fromBonus: string) =>
    db.drizzle.db.transaction((tx) =>
      new WageringService().wager(tx, {
        userId,
        currency: 'USD',
        stake: '10',
        fromBonus,
        context: { provider: 'aggregator', product },
        providerName: 'aggregator',
        externalRoundId: randomUUID(),
      }),
    );

  const bonusBalanceOf = async (grantId: string) =>
    findOneOrThrow(
      await db.drizzle.db
        .select({ bonusBalance: promoGrant.bonusBalance })
        .from(promoGrant)
        .where(eq(promoGrant.id, grantId)),
      new Error('grant row missing'),
    ).bonusBalance;

  const stakesOf = (grantId: string) =>
    db.drizzle.db.select().from(promoGrantEntry).where(eq(promoGrantEntry.grantId, grantId));

  it.each(EXCLUDED)(
    'refuses a %s bet that needs bonus funds and leaves the grant untouched',
    async (product) => {
      const userId = randomUUID();
      const grantId = await grantFor(userId, [...EXCLUDED]);

      const outcome = await bet(userId, product, '10');

      expect(outcome).toEqual({ ok: false, reason: 'insufficient_bonus', bonusAvailable: '0' });
      expect(Number(await bonusBalanceOf(grantId))).toBe(100);
      expect((await stakesOf(grantId)).map((e) => e.type)).toEqual(['grant']);
    },
  );

  it('accepts a pvp bet the real balance pays in full while a bonus is active', async () => {
    const userId = randomUUID();
    const grantId = await grantFor(userId, [...EXCLUDED]);

    const outcome = await bet(userId, 'pvp', '0');

    expect(outcome).toMatchObject({ ok: true, grantId, bonusSpent: '0' });
    expect(Number(await bonusBalanceOf(grantId))).toBe(100);
  });

  it('still pays a casino bet from bonus funds', async () => {
    const userId = randomUUID();
    const grantId = await grantFor(userId, [...EXCLUDED]);

    const outcome = await bet(userId, 'casino', '10');

    expect(outcome).toMatchObject({ ok: true, grantId, bonusSpent: '10' });
    expect(Number(await bonusBalanceOf(grantId))).toBe(90);
  });

  it('pays a live-casino bet from bonus funds when the grant excludes no product', async () => {
    const userId = randomUUID();
    const grantId = await grantFor(userId);

    const outcome = await bet(userId, 'live-casino', '10');

    expect(outcome).toMatchObject({ ok: true, grantId, bonusSpent: '10' });
    expect(Number(await bonusBalanceOf(grantId))).toBe(90);
  });
});
