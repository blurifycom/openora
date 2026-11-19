import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type {
  BonusFundSettings,
  BonusGrantArgs,
  Uuid,
  WagerContext,
} from '@openora/core/contracts';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoGrant,
  promoGrantEntry,
  promoGrantRound,
  promoWeight,
  promoWeightProfile,
} from '../schema/index.js';
import { seedDefaultWeightProfile } from '../seed/index.js';
import { GrantService } from '../service/grant.service.js';
import { WageringService } from '../service/wagering.service.js';
import { WeightService } from '../service/weight.service.js';

let db: TestDb;
const audit = makeAuditWriter();
const grants = new GrantService(audit);
const wagering = new WageringService(audit);
const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const n = (value: string | null | undefined) => Number(value ?? 'NaN');

beforeAll(async () => {
  db = await createTestDb([migrate]);
  await seedDefaultWeightProfile(db.drizzle.db);
});

afterAll(async () => {
  await db.drop();
});

type WeightRow = Pick<
  typeof promoWeight.$inferInsert,
  'scope' | 'scopeRef' | 'contributionPercent'
>;

const profile = async (
  rows: WeightRow[],
  contribution: Partial<
    Pick<typeof promoWeightProfile.$inferInsert, 'contributionMode' | 'referenceEdge'>
  > = {},
) => {
  const created = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}`, ...contribution })
      .returning(),
    new Error('profile insert returned no row'),
  );
  await db.drizzle.db
    .insert(promoWeight)
    .values(rows.map((r) => ({ ...r, profileId: created.id })));
  return created.id;
};

const grant = async (over: Partial<BonusGrantArgs> = {}) => {
  const outcome = await db.drizzle.db.transaction((tx) =>
    grants.grant(tx, {
      userId: randomUUID(),
      currency: 'USD',
      amount: '1000',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '1', expiryDays: 30 },
      ...over,
    }),
  );
  if (!outcome.ok) {
    throw new Error('grant was refused');
  }
  return outcome.grantId;
};

const rowOf = async (id: string) =>
  findOneOrThrow(
    await db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.id, id)),
    new Error('grant row missing'),
  );

const bet = (
  userId: string,
  stake: string,
  round: string,
  context: WagerContext = CASINO,
  realAvailable = '0',
) =>
  db.drizzle.db.transaction((tx) =>
    wagering.wager(tx, {
      userId,
      currency: 'USD',
      stake,
      realAvailable,
      context,
      providerName: 'aggregator',
      externalRoundId: round,
    }),
  );

const close = (userId: string, round: string) =>
  db.drizzle.db.transaction((tx) =>
    wagering.closeRound(tx, {
      userId,
      currency: 'USD',
      providerName: 'aggregator',
      externalRoundId: round,
      realBalance: '0',
    }),
  );

const reverse = (userId: string, round: string, amount: string) =>
  db.drizzle.db.transaction((tx) =>
    wagering.settle(tx, {
      userId,
      currency: 'USD',
      amount,
      providerName: 'aggregator',
      externalRoundId: round,
      kind: 'bet_reversal',
      realBalance: '0',
    }),
  );

const entriesOf = (grantId: string, type: (typeof promoGrantEntry.$inferSelect)['type']) =>
  db.drizzle.db
    .select()
    .from(promoGrantEntry)
    .where(and(eq(promoGrantEntry.grantId, grantId), eq(promoGrantEntry.type, type)));

const pendingOf = async (grantId: string, round: string) =>
  findOneOrThrow(
    await db.drizzle.db
      .select()
      .from(promoGrantRound)
      .where(and(eq(promoGrantRound.grantId, grantId), eq(promoGrantRound.externalRoundId, round))),
    new Error('round row missing'),
  ).progressPending;

const sumDeltas = (rows: { wageringDelta: string }[]) =>
  rows.reduce((sum, row) => sum + n(row.wageringDelta), 0);

describe('progress credited at settlement', () => {
  it('holds a stake as pending, then credits it once when the round closes', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });
    const round = randomUUID();

    expect(await bet(userId, '100', round)).toMatchObject({
      ok: true,
      weightedAmount: expect.any(String),
    });
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(0);
    expect(n(await pendingOf(grantId, round))).toBe(100);
    const [stake] = await entriesOf(grantId, 'stake');
    expect(n(stake?.wageringDelta)).toBe(0);

    await close(userId, round);
    await close(userId, round);

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(100);
    expect(n(await pendingOf(grantId, round))).toBe(0);
    const progress = await entriesOf(grantId, 'progress');
    expect(progress).toHaveLength(1);
    expect(n(progress[0]?.wageringDelta)).toBe(100);
    expect(n(progress[0]?.bonusAmount)).toBe(0);
  });

  it('records no rtp on the stake when the provider sent a malformed one', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });
    await bet(userId, '10', randomUUID(), { ...CASINO, rtp: '96' });

    const [stake] = await entriesOf(grantId, 'stake');
    expect(stake?.wagerInputs).toMatchObject({ mode: 'flat', rtp: null, referenceEdge: null });
  });

  it('caps the credit at the room open rounds leave, and a full reversal takes back exactly what it credited', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '60' });
    const keepOpen = randomUUID();
    const round = randomUUID();
    await bet(userId, '10', keepOpen);
    await bet(userId, '100', round);

    await close(userId, round);
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(50);
    expect((await rowOf(grantId)).status).toBe('active');

    await reverse(userId, round, '100');

    const after = await rowOf(grantId);
    expect(n(after.wageringProgress)).toBe(0);
    const [reversal] = await entriesOf(grantId, 'reversal');
    expect(n(reversal?.wageringDelta)).toBe(-50);
  });

  it('halves the pending progress on a half reversal before the round settles', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });
    const round = randomUUID();
    await bet(userId, '100', round);

    await reverse(userId, round, '50');

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(50);
    expect(sumDeltas(await entriesOf(grantId, 'progress'))).toBe(50);
    expect(n(await pendingOf(grantId, round))).toBe(0);
  });

  it('settles a stake taken before settlement-time credit on what its stake row already counted', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });
    const round = randomUUID();
    const key = { userId, currency: 'USD', providerName: 'aggregator', externalRoundId: round };
    await db.drizzle.db.transaction(async (tx) => {
      await tx
        .update(promoGrant)
        .set({ bonusBalance: '960', wageringProgress: '40' })
        .where(eq(promoGrant.id, grantId));
      await tx.insert(promoGrantEntry).values({
        ...key,
        grantId,
        type: 'stake',
        bonusAmount: '-40',
        realAmount: '0',
        wageringDelta: '40',
        balanceAfter: '960',
      });
      await tx.insert(promoGrantRound).values({ ...key, grantId });
    });

    await close(userId, round);
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(40);
    expect(await entriesOf(grantId, 'progress')).toEqual([]);

    await reverse(userId, round, '40');
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(0);
  });

  it('converts in the transaction that settles the bet meeting the requirement', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '100' });
    const round = randomUUID();
    await bet(userId, '100', round);
    expect((await rowOf(grantId)).status).toBe('active');

    const { completed } = await close(userId, round);

    expect(completed).toEqual([{ grantId, convertedAmount: expect.any(String) }]);
    expect((await rowOf(grantId)).status).toBe('completed');
  });
});

describe('settlement under concurrency', () => {
  it('neither deadlocks nor loses progress when a stake races the close of its own round', async () => {
    for (let i = 0; i < 8; i += 1) {
      const userId = randomUUID();
      const grantId = await grant({ userId });
      const round = randomUUID();
      await bet(userId, '100', round);

      await Promise.all([bet(userId, '100', round), close(userId, round)]);

      const credited = n((await rowOf(grantId)).wageringProgress);
      expect(credited + n(await pendingOf(grantId, round))).toBe(200);
      expect(sumDeltas(await entriesOf(grantId, 'progress'))).toBe(credited);
    }
  });

  it('never credits past the requirement when two rounds settle at once', async () => {
    for (let i = 0; i < 8; i += 1) {
      const userId = randomUUID();
      const grantId = await grant({ userId, wageringRequired: '150' });
      const [a, b] = [randomUUID(), randomUUID()];
      await bet(userId, '100', a);
      await bet(userId, '100', b);

      await Promise.all([close(userId, a), close(userId, b)]);

      expect(sumDeltas(await entriesOf(grantId, 'progress'))).toBe(150);
      expect((await rowOf(grantId)).status).toBe('completed');
    }
  });
});

describe('house-edge contribution', () => {
  it('records the inputs a stake was scored on, and a later profile edit changes nothing', async () => {
    const profileId = await profile(
      [
        { scope: 'default', scopeRef: null, contributionPercent: '100' },
        { scope: 'category', scopeRef: 'table', contributionPercent: '70' },
      ],
      { contributionMode: 'house_edge', referenceEdge: '0.04' },
    );
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      terms: { wageringMultiplier: '1', expiryDays: 30, weightProfileId: profileId },
    });
    const round = randomUUID();

    await bet(userId, '100', round, { ...CASINO, categorySlug: 'table', rtp: '0.97' });

    const [stake] = await entriesOf(grantId, 'stake');
    expect(stake?.wagerInputs).toMatchObject({
      mode: 'house_edge',
      rtp: '0.97',
      betClass: 'contributing',
      profileVersion: 1,
    });
    expect(n(stake?.wagerInputs?.categoryPercent)).toBe(70);
    expect(n(stake?.wagerInputs?.referenceEdge)).toBe(0.04);
    expect(n(stake?.wagerInputs?.effectivePercent)).toBe(52.5);

    await new WeightService(db.drizzle, makeAuditWriter()).set(randomUUID() as Uuid, {
      id: profileId as Uuid,
      contributionMode: 'flat',
      weights: [{ scope: 'default', scopeRef: null, contributionPercent: '100' }],
    });
    await close(userId, round);

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(52.5);
    const { terms } = await rowOf(grantId);
    expect(terms).toMatchObject({ contributionMode: 'house_edge', weightProfileVersion: 1 });
    expect(terms.weights).toHaveLength(2);
  });
});

describe('grants made before contribution modes', () => {
  it('scores flat, still funds a 0% bet from C, and leaves a sportsbook bet unattributed', async () => {
    const profileId = await profile([
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
      { scope: 'category', scopeRef: 'blackjack', contributionPercent: '0' },
    ]);
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      terms: { wageringMultiplier: '1', expiryDays: 30, weightProfileId: profileId },
    });
    const legacy = await rowOf(grantId);
    const { contributionMode, referenceEdge, weightProfileVersion, ...terms } = legacy.terms;
    expect(contributionMode).toBe('flat');
    expect(referenceEdge).toBeUndefined();
    expect(weightProfileVersion).toBe(1);
    await db.drizzle.db.update(promoGrant).set({ terms }).where(eq(promoGrant.id, grantId));

    const round = randomUUID();
    expect(await bet(userId, '100', round, { ...CASINO, rtp: '0.5' })).toMatchObject({ ok: true });
    expect(n(await pendingOf(grantId, round))).toBe(100);

    const zero = await bet(userId, '10', randomUUID(), { ...CASINO, categorySlug: 'blackjack' });
    expect(zero).toMatchObject({ ok: true, grantId });
    expect(zero.ok && n(zero.bonusSpent)).toBe(10);

    const sport = await bet(
      userId,
      '10',
      randomUUID(),
      { provider: 'sb', product: 'sportsbook' },
      '10',
    );
    expect(sport).toMatchObject({ ok: true, grantId: null });
  });
});

describe('bet class buckets', () => {
  it('keeps C away from an excluded product even when its class may draw on C', async () => {
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      terms: {
        wageringMultiplier: '1',
        expiryDays: 30,
        excludedProducts: ['live-casino'],
        funds: {
          rolloverBase: 'bonus',
          existingBalance: 'free',
          freeFundsOrder: 'first',
          dustThresholdUsd: '0',
          decimals: 2,
          betClassBuckets: { contributing: ['unlinked', 'linked', 'bonus'] },
        },
      },
    });

    const outcome = await bet(userId, '10', randomUUID(), { ...CASINO, product: 'live-casino' });

    expect(outcome).toEqual({ ok: false, reason: 'insufficient_bonus', bonusAvailable: '0' });
    expect(n((await rowOf(grantId)).bonusBalance)).toBe(1000);
    expect(await entriesOf(grantId, 'stake')).toEqual([]);
  });
});

describe('a reversal after the round settled', () => {
  it('takes back the reversed share of a full credit', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });
    const round = randomUUID();
    await bet(userId, '100', round);
    await close(userId, round);

    await reverse(userId, round, '30');

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(70);
    expect(sumDeltas(await entriesOf(grantId, 'reversal'))).toBe(-30);
  });

  it('takes back the reversed share of a capped credit, and no more than progress drops', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '60' });
    const keepOpen = randomUUID();
    const round = randomUUID();
    await bet(userId, '10', keepOpen);
    await bet(userId, '100', round);
    await close(userId, round);
    const before = n((await rowOf(grantId)).wageringProgress);

    await reverse(userId, round, '50');

    const after = n((await rowOf(grantId)).wageringProgress);
    expect([before, after]).toEqual([50, 25]);
    expect(sumDeltas(await entriesOf(grantId, 'reversal'))).toBe(after - before);
  });
});

describe('room left on a grant', () => {
  const freeFunds: BonusFundSettings = {
    rolloverBase: 'bonus',
    existingBalance: 'free',
    freeFundsOrder: 'first',
    dustThresholdUsd: '0',
    decimals: 2,
  };

  it('counts progress open rounds hold, so a second round goes to the next grant', async () => {
    const userId = randomUUID();
    const first = await grant({
      userId,
      wageringRequired: '100',
      terms: { wageringMultiplier: '1', expiryDays: 10, funds: freeFunds },
    });
    const second = await grant({
      userId,
      wageringRequired: '1000',
      terms: { wageringMultiplier: '1', expiryDays: 30, funds: freeFunds },
    });
    const r1 = randomUUID();
    const r2 = randomUUID();

    await bet(userId, '100', r1, CASINO, '100');
    await bet(userId, '100', r2, CASINO, '100');

    expect(n(await pendingOf(first, r1))).toBe(100);
    expect(n(await pendingOf(second, r2))).toBe(100);
    await close(userId, r1);
    await close(userId, r2);
    expect(n((await rowOf(first)).wageringProgress)).toBe(100);
    expect(n((await rowOf(second)).wageringProgress)).toBe(100);
  });
});

describe('a real-money-only product paid from grant cash', () => {
  it('records the scoring it applied: nothing earned, the default class', async () => {
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      amount: '50',
      buckets: { unlinked: '15', linked: '10' },
      terms: {
        wageringMultiplier: '1',
        expiryDays: 30,
        funds: {
          rolloverBase: 'bonus',
          existingBalance: 'locked',
          freeFundsOrder: 'first',
          dustThresholdUsd: '0',
          decimals: 2,
          betClassBuckets: { zero: ['bonus'] },
        },
      },
    });

    const outcome = await bet(
      userId,
      '20',
      randomUUID(),
      { provider: 'sb', product: 'sportsbook' },
      '25',
    );

    expect(outcome).toMatchObject({ ok: true, grantId });
    const [stake] = await entriesOf(grantId, 'stake');
    expect(stake?.wagerInputs).toMatchObject({ effectivePercent: '0', betClass: 'zero' });
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(0);
  });
});
