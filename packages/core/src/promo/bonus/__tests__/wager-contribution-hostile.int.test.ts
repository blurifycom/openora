import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type {
  BonusFundSettings,
  BonusGrantArgs,
  Uuid,
  WagerContext,
} from '@openora/core/contracts';
import { makeAuditWriter } from './support/doubles.js';
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

const funds = (
  betClassBuckets?: BonusFundSettings['betClassBuckets'],
  over: Partial<BonusFundSettings> = {},
): BonusFundSettings => ({
  rolloverBase: 'bonus',
  existingBalance: 'free',
  freeFundsOrder: 'first',
  dustThresholdUsd: '0',
  decimals: 2,
  ...(betClassBuckets ? { betClassBuckets } : {}),
  ...over,
});

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
  currency = 'USD',
) =>
  db.drizzle.db.transaction((tx) =>
    wagering.wager(tx, {
      userId,
      currency,
      stake,
      realAvailable,
      context,
      providerName: 'aggregator',
      externalRoundId: round,
    }),
  );

const close = (userId: string, round: string, currency = 'USD') =>
  db.drizzle.db.transaction((tx) =>
    wagering.closeRound(tx, {
      userId,
      currency,
      providerName: 'aggregator',
      externalRoundId: round,
      realBalance: '0',
    }),
  );

const settle = (userId: string, round: string, amount: string, kind: 'win' | 'bet_reversal') =>
  db.drizzle.db.transaction((tx) =>
    wagering.settle(tx, {
      userId,
      currency: 'USD',
      amount,
      providerName: 'aggregator',
      externalRoundId: round,
      kind,
      realBalance: '0',
      ...(kind === 'win' ? { final: true } : {}),
    }),
  );

const entriesOf = (grantId: string, type?: (typeof promoGrantEntry.$inferSelect)['type']) =>
  db.drizzle.db
    .select()
    .from(promoGrantEntry)
    .where(
      type
        ? and(eq(promoGrantEntry.grantId, grantId), eq(promoGrantEntry.type, type))
        : eq(promoGrantEntry.grantId, grantId),
    );

const roundsOf = (grantId: string) =>
  db.drizzle.db.select().from(promoGrantRound).where(eq(promoGrantRound.grantId, grantId));

const pendingOf = async (grantId: string, round: string) =>
  findOneOrThrow(
    await db.drizzle.db
      .select()
      .from(promoGrantRound)
      .where(and(eq(promoGrantRound.grantId, grantId), eq(promoGrantRound.externalRoundId, round))),
    new Error('round row missing'),
  ).progressPending;

const snapshot = async (grantId: string) => ({
  grant: await rowOf(grantId),
  entries: (await entriesOf(grantId)).length,
  rounds: await roundsOf(grantId),
});

const permittedOf = (outcome: Awaited<ReturnType<typeof bet>>) =>
  outcome.ok === false && 'permitted' in outcome ? outcome.permitted : 'none';

describe('a settled round cannot pay progress twice', () => {
  it('credits nothing for a win, a replayed win or a replayed close after the round settled', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '1000' });
    const round = randomUUID();
    await bet(userId, '100', round);
    await close(userId, round);
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(100);

    await settle(userId, round, '30', 'win');
    await settle(userId, round, '30', 'win');
    await close(userId, round);

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(100);
    expect(await entriesOf(grantId, 'progress')).toHaveLength(1);
    expect(n(await pendingOf(grantId, round))).toBe(0);
  });

  it('writes one progress entry when three closes of one round run at once', async () => {
    for (let i = 0; i < 6; i += 1) {
      const userId = randomUUID();
      const grantId = await grant({ userId, wageringRequired: '1000' });
      const round = randomUUID();
      await bet(userId, '100', round);

      await Promise.all([close(userId, round), close(userId, round), close(userId, round)]);

      expect(n((await rowOf(grantId)).wageringProgress)).toBe(100);
      expect(await entriesOf(grantId, 'progress')).toHaveLength(1);
    }
  });

  it('credits a win that settles a round exactly once', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '1000' });
    const round = randomUUID();
    await bet(userId, '100', round);

    await settle(userId, round, '250', 'win');
    await settle(userId, round, '250', 'win');

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(100);
    expect(await entriesOf(grantId, 'progress')).toHaveLength(1);
  });
});

describe('a reversal larger or later than its stake', () => {
  it('takes back what the round credited and no more, however large the callback or often it repeats', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '1000' });
    const other = randomUUID();
    const round = randomUUID();
    await bet(userId, '70', other);
    await close(userId, other);
    await bet(userId, '100', round);
    await close(userId, round);
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(170);

    const first = await settle(userId, round, '500', 'bet_reversal');
    const second = await settle(userId, round, '500', 'bet_reversal');

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(70);
    expect(n(first.bonusShare)).toBe(100);
    expect([second.bonusShare, second.realShare].map(n)).toEqual([0, 0]);
    expect((await entriesOf(grantId, 'reversal')).map((e) => n(e.wageringDelta))).toEqual([-100]);
    expect(n((await rowOf(grantId)).bonusBalance)).toBe(1000 - 70);
  });

  it('never drives progress or pending below zero when a reversal races the close of its round', async () => {
    for (let i = 0; i < 8; i += 1) {
      const userId = randomUUID();
      const grantId = await grant({ userId, wageringRequired: '1000' });
      const round = randomUUID();
      await bet(userId, '100', round);

      await Promise.all([settle(userId, round, '100', 'bet_reversal'), close(userId, round)]);

      expect(n((await rowOf(grantId)).wageringProgress)).toBe(0);
      expect(n(await pendingOf(grantId, round))).toBe(0);
      expect(n((await rowOf(grantId)).bonusBalance)).toBe(1000);
    }
  });
});

describe('restricted funds', () => {
  const setup = async (betClassBuckets: BonusFundSettings['betClassBuckets']) => {
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      amount: '50',
      buckets: { unlinked: '10', linked: '10' },
      terms: { wageringMultiplier: '1', expiryDays: 30, funds: funds(betClassBuckets) },
    });
    return { userId, grantId };
  };

  it('leaves the grant, its entries and its rounds exactly as they were when it refuses', async () => {
    const { userId, grantId } = await setup({ contributing: ['unlinked'] });
    await bet(userId, '5', randomUUID(), CASINO, '20');
    const before = await snapshot(grantId);

    const refused = await bet(userId, '40', randomUUID(), CASINO, '20');

    expect(refused).toMatchObject({ ok: false, reason: 'restricted_funds' });
    expect(await snapshot(grantId)).toEqual(before);
  });

  it('reports as permitted exactly what a retry can pay, free money and every allowed bucket included', async () => {
    for (const [allowed, expected] of [
      [['bonus'], 55],
      [['linked'], 15],
      [['unlinked', 'linked'], 25],
      [[], 5],
    ] as const) {
      const { userId, grantId } = await setup({ contributing: [...allowed] });
      const before = await snapshot(grantId);

      const refused = await bet(userId, '70', randomUUID(), CASINO, '25');

      expect(refused).toMatchObject({ ok: false, reason: 'restricted_funds' });
      const permitted = permittedOf(refused);
      expect(n(permitted)).toBe(expected);
      expect(await snapshot(grantId)).toEqual(before);

      expect(await bet(userId, permitted, randomUUID(), CASINO, '25')).toMatchObject({ ok: true });
      expect((await snapshot(grantId)).entries).toBe(before.entries + 1);
      expect(await bet(userId, '0.01', randomUUID(), CASINO, '0')).toMatchObject({ ok: false });
    }
  });

  it('lets only free real money pay a class with an empty list', async () => {
    const profileId = await profile([
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
      { scope: 'category', scopeRef: 'nothing', contributionPercent: '0' },
    ]);
    const userId = randomUUID();
    await grant({
      userId,
      amount: '50',
      buckets: { unlinked: '10', linked: '10' },
      terms: {
        wageringMultiplier: '1',
        expiryDays: 30,
        weightProfileId: profileId,
        funds: funds({ zero: [] }),
      },
    });
    const zero: WagerContext = { ...CASINO, categorySlug: 'nothing' };

    const paid = await bet(userId, '5', randomUUID(), zero, '25');
    expect(paid).toMatchObject({ ok: true, grantId: null });
    expect(n(paid.ok ? paid.bonusSpent : 'NaN')).toBe(0);
    const refused = await bet(userId, '6', randomUUID(), zero, '25');
    expect(refused).toMatchObject({ ok: false, reason: 'restricted_funds' });
    expect(n(permittedOf(refused))).toBe(5);
  });

  it('honours the class rule in existingBalance locked mode, where the whole balance is A and B', async () => {
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      amount: '50',
      buckets: { unlinked: '15', linked: '10' },
      terms: {
        wageringMultiplier: '1',
        expiryDays: 30,
        funds: funds({ contributing: ['bonus'] }, { existingBalance: 'locked' }),
      },
    });

    const refused = await bet(userId, '60', randomUUID(), CASINO, '25');
    expect(refused).toMatchObject({ ok: false, reason: 'restricted_funds' });
    expect(n(permittedOf(refused))).toBe(50);

    expect(await bet(userId, '50', randomUUID(), CASINO, '25')).toMatchObject({ ok: true });
    const row = await rowOf(grantId);
    expect([row.bonusBalance, row.unlinkedCash, row.linkedCash].map(n)).toEqual([0, 15, 10]);
  });
});

describe('a PvP bet', () => {
  it('stays inside its class buckets, and counts by its profile weight when that is positive', async () => {
    const profileId = await profile([
      { scope: 'default', scopeRef: null, contributionPercent: '100' },
      { scope: 'product', scopeRef: 'pvp', contributionPercent: '100' },
    ]);
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      amount: '50',
      buckets: { unlinked: '5', linked: '10' },
      terms: {
        wageringMultiplier: '1',
        expiryDays: 30,
        weightProfileId: profileId,
        funds: funds({ pvp: ['unlinked'] }),
      },
    });
    const pvp: WagerContext = { provider: 'aggregator', product: 'pvp' };
    const round = randomUUID();

    expect(await bet(userId, '5', round, pvp, '15')).toMatchObject({ ok: true });
    expect(await bet(userId, '6', randomUUID(), pvp, '10')).toMatchObject({
      ok: false,
      reason: 'restricted_funds',
    });

    const [stake] = await entriesOf(grantId, 'stake');
    expect(stake?.wagerInputs?.betClass).toBe('pvp');
    expect(n(await pendingOf(grantId, round))).toBe(5);
  });
});

describe('a grant that is no longer active', () => {
  it('credits nothing and takes nothing for a round it held pending progress on', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '1000' });
    const base = randomUUID();
    await bet(userId, '40', base);
    await close(userId, base);
    const round = randomUUID();
    await bet(userId, '100', round);
    expect(n(await pendingOf(grantId, round))).toBe(100);

    await db.drizzle.db
      .update(promoGrant)
      .set({ status: 'expired', closedAt: new Date() })
      .where(eq(promoGrant.id, grantId));
    const closed = await close(userId, round);
    const reversed = await settle(userId, round, '100', 'bet_reversal');

    expect(closed.completed).toEqual([]);
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(40);
    expect(await entriesOf(grantId, 'progress')).toHaveLength(1);
    expect(n(await pendingOf(grantId, round))).toBe(0);
    expect(n(reversed.bonusShare)).toBe(0);
  });
});

describe('a profile edit racing a grant', () => {
  it('snapshots weights and version from one committed state, never half of two', async () => {
    const profileId = await profile([
      { scope: 'default', scopeRef: null, contributionPercent: '1' },
    ]);
    const weights = new WeightService(db.drizzle, makeAuditWriter());
    const editor = (async () => {
      for (let percent = 2; percent <= 40; percent += 1) {
        await weights.set(randomUUID() as Uuid, {
          id: profileId as Uuid,
          weights: [{ scope: 'default', scopeRef: null, contributionPercent: String(percent) }],
        });
      }
    })();

    const seen: { version: number | undefined; percent: string | undefined }[] = [];
    for (let i = 0; i < 40; i += 1) {
      const grantId = await grant({
        amount: '10',
        terms: { wageringMultiplier: '1', expiryDays: 30, weightProfileId: profileId },
      });
      const { terms } = await rowOf(grantId);
      seen.push({
        version: terms.weightProfileVersion,
        percent: terms.weights?.[0]?.contributionPercent,
      });
    }
    await editor;

    expect(seen).toHaveLength(40);
    for (const { version, percent } of seen) {
      expect(n(percent)).toBe(version ?? 0);
    }
  });
});

describe('house-edge precision', () => {
  const houseEdge = (referenceEdge: string) =>
    profile([{ scope: 'default', scopeRef: null, contributionPercent: '100' }], {
      contributionMode: 'house_edge',
      referenceEdge,
    });

  it('keeps an 18-decimal stake exact and never rounds it up, with a reference edge of 1', async () => {
    const profileId = await houseEdge('1');
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      currency: 'ETH',
      amount: '1',
      terms: {
        wageringMultiplier: '1',
        expiryDays: 30,
        weightProfileId: profileId,
        funds: funds(undefined, { decimals: 18 }),
      },
    });
    const round = randomUUID();

    await bet(userId, '0.000000000000000003', round, { ...CASINO, rtp: '0.5' }, '0', 'ETH');

    expect(await pendingOf(grantId, round)).toBe('0.000000000000000001');
  });

  it('counts a 2-decimal currency bet at full precision and truncates a sub-unit stake to nothing', async () => {
    const profileId = await houseEdge('0.04');
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      amount: '100',
      terms: { wageringMultiplier: '1', expiryDays: 30, weightProfileId: profileId },
    });
    const round = randomUUID();

    await bet(userId, '0.01', round, { ...CASINO, rtp: '0.97' });
    expect(await pendingOf(grantId, round)).toBe('0.007500000000000000');

    const tiny = randomUUID();
    await bet(userId, '0.000000000000000001', tiny, { ...CASINO, rtp: '0.97' });
    expect(await pendingOf(grantId, tiny)).toBe('0.000000000000000000');
  });
});

describe('a settlement with no grant behind the round', () => {
  it('regression guard: a cash-only win or reversal writes nothing and waits on no grant lock', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId });
    const before = await snapshot(grantId);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.drizzle.db.transaction(async (tx) => {
      await tx.select().from(promoGrant).where(eq(promoGrant.id, grantId)).for('update');
      locked();
      await held;
    });
    await lockTaken;

    // A wait on the held grant lock fails the transaction instead of hanging the test.
    const settled = db.drizzle.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      const base = { userId, currency: 'USD', providerName: 'aggregator', realBalance: '0' };
      const win = await wagering.settle(tx, {
        ...base,
        amount: '25',
        externalRoundId: randomUUID(),
        kind: 'win',
      });
      const reversal = await wagering.settle(tx, {
        ...base,
        amount: '25',
        externalRoundId: randomUUID(),
        kind: 'bet_reversal',
      });
      const closed = await wagering.closeRound(tx, { ...base, externalRoundId: randomUUID() });
      return { win, reversal, closed };
    });
    const outcome = await settled.finally(release);
    await holder;

    expect(outcome).toMatchObject({
      win: { bonusShare: '0', realShare: '25' },
      reversal: { bonusShare: '0', realShare: '25' },
      closed: { completed: [] },
    });
    expect(await snapshot(grantId)).toEqual(before);
  });
});

describe('progress stranded on a round already marked settled', () => {
  const strand = async (round: string, grantId: string) => {
    await db.drizzle.db
      .update(promoGrantRound)
      .set({ settledAt: new Date() })
      .where(and(eq(promoGrantRound.grantId, grantId), eq(promoGrantRound.externalRoundId, round)));
  };

  it('credits once however a replay arrives: close, win or concurrent closes', async () => {
    for (const replay of ['close', 'win', 'race'] as const) {
      const userId = randomUUID();
      const grantId = await grant({ userId, wageringRequired: '1000' });
      const round = randomUUID();
      await bet(userId, '40', round);
      await strand(round, grantId);

      if (replay === 'close') {
        await close(userId, round);
        await close(userId, round);
      } else if (replay === 'win') {
        await settle(userId, round, '10', 'win');
        await settle(userId, round, '10', 'win');
      } else {
        await Promise.all([close(userId, round), close(userId, round), close(userId, round)]);
      }

      expect(n((await rowOf(grantId)).wageringProgress), replay).toBe(40);
      expect(await entriesOf(grantId, 'progress'), replay).toHaveLength(1);
      expect(n(await pendingOf(grantId, round)), replay).toBe(0);
    }
  });

  it('is capped at the headroom, and a stranded row on a grant that is no longer active credits nothing', async () => {
    const userId = randomUUID();
    const capped = await grant({ userId, wageringRequired: '25' });
    const round = randomUUID();
    await bet(userId, '40', round);
    await strand(round, capped);
    await close(userId, round);
    expect(n((await rowOf(capped)).wageringProgress)).toBe(25);

    const other = randomUUID();
    const dead = await grant({ userId: other, wageringRequired: '1000' });
    const deadRound = randomUUID();
    await bet(other, '40', deadRound);
    await strand(deadRound, dead);
    await db.drizzle.db
      .update(promoGrant)
      .set({ status: 'expired', closedAt: new Date() })
      .where(eq(promoGrant.id, dead));
    await close(other, deadRound);
    await close(other, deadRound);
    expect(n((await rowOf(dead)).wageringProgress)).toBe(0);
    expect(await entriesOf(dead, 'progress')).toEqual([]);
    expect(n(await pendingOf(dead, deadRound))).toBe(0);
  });

  it('is taken back by a full reversal instead of being credited afterwards', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '1000' });
    const round = randomUUID();
    await bet(userId, '40', round);
    await strand(round, grantId);

    await settle(userId, round, '40', 'bet_reversal');
    await close(userId, round);

    expect(n((await rowOf(grantId)).wageringProgress)).toBe(0);
    expect(n(await pendingOf(grantId, round))).toBe(0);
    expect(n((await rowOf(grantId)).bonusBalance)).toBe(1000);
  });
});

describe('a stake landing on another grant while its round settles', () => {
  it('never loses its progress: credited plus pending is the whole stake, and the next close credits the rest', async () => {
    for (let i = 0; i < 8; i += 1) {
      const userId = randomUUID();
      const first = await grant({ userId, wageringRequired: '1000' });
      const round = randomUUID();
      await bet(userId, '100', round);
      await db.drizzle.db
        .update(promoGrant)
        .set({ status: 'expired', closedAt: new Date() })
        .where(eq(promoGrant.id, first));
      const second = await grant({ userId, wageringRequired: '1000' });

      const [staked] = await Promise.all([bet(userId, '60', round), close(userId, round)]);

      expect(staked).toMatchObject({ ok: true, grantId: second });
      const credited = n((await rowOf(second)).wageringProgress);
      expect(credited + n(await pendingOf(second, round))).toBe(60);
      await close(userId, round);
      expect(n((await rowOf(second)).wageringProgress)).toBe(60);
      expect(n(await pendingOf(second, round))).toBe(0);
      expect(await entriesOf(second, 'progress')).toHaveLength(1);
    }
  });
});
