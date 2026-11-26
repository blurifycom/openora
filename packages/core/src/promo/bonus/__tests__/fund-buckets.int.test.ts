import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { BonusGrantArgs, Uuid, WagerContext } from '@openora/core/contracts';
import {
  makeAuditWriter,
  makeEventBus,
  makeWalletReader,
  unrestricted,
} from './support/doubles.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry, promoOffer, promoOptIn } from '../schema/index.js';
import { seedDefaultWeightProfile } from '../seed/index.js';
import { GrantLifecycleService } from '../service/grant-lifecycle.service.js';
import { GrantService } from '../service/grant.service.js';
import { OfferService } from '../service/offer.service.js';
import { WageringService } from '../service/wagering.service.js';

let db: TestDb;
let realBalance = '0';
const CASINO: WagerContext = { provider: 'aggregator', product: 'casino' };
const audit = makeAuditWriter();
const grants = new GrantService(audit);
const wagering = new WageringService(audit);

beforeAll(async () => {
  db = await createTestDb([migrate]);
  await seedDefaultWeightProfile(db.drizzle.db);
});

afterAll(async () => {
  await db.drop();
});

const grant = async (over: Partial<BonusGrantArgs> = {}) => {
  const outcome = await db.drizzle.db.transaction((tx) =>
    grants.grant(tx, {
      userId: randomUUID(),
      currency: 'USD',
      amount: '10',
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

const n = (value: string) => Number(value);

const bet = (userId: string, stake: string, realAvailable: string, externalRoundId: string) =>
  db.drizzle.db.transaction((tx) =>
    wagering.wager(tx, {
      userId,
      currency: 'USD',
      stake,
      realAvailable,
      context: CASINO,
      providerName: 'aggregator',
      externalRoundId,
    }),
  );

const lose = (userId: string, externalRoundId: string, real: string) =>
  db.drizzle.db.transaction((tx) =>
    wagering.closeRound(tx, {
      userId,
      currency: 'USD',
      providerName: 'aggregator',
      externalRoundId,
      realBalance: real,
    }),
  );

describe('completion', () => {
  it('waits for the bet that met the requirement to settle, then converts and resets the counters', async () => {
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      buckets: { linked: '10', unlinked: '0' },
      wageringRequired: '10',
    });
    const round = randomUUID();

    expect(await bet(userId, '10', '10', round)).toMatchObject({ ok: true, grantId });
    expect(await rowOf(grantId)).toMatchObject({ status: 'active' });
    expect(n((await rowOf(grantId)).wageringProgress)).toBe(0);

    const { completed } = await lose(userId, round, '0');

    expect(completed).toEqual([{ grantId, convertedAmount: expect.any(String) }]);
    expect(n(completed[0]?.convertedAmount ?? '0')).toBe(10);
    const after = await rowOf(grantId);
    expect(after.status).toBe('completed');
    expect([after.bonusBalance, after.linkedCash, after.unlinkedCash].map(n)).toEqual([0, 0, 0]);
  });
});

describe('proportional return', () => {
  it('splits a win back into B and C in the shares the stake paid', async () => {
    const userId = randomUUID();
    const grantId = await grant({
      userId,
      buckets: { linked: '10', unlinked: '0' },
      wageringRequired: '1000',
    });
    const round = randomUUID();
    await bet(userId, '20', '10', round);

    const settled = await db.drizzle.db.transaction((tx) =>
      wagering.settle(tx, {
        userId,
        currency: 'USD',
        amount: '40',
        providerName: 'aggregator',
        externalRoundId: round,
        kind: 'win',
        realBalance: '0',
      }),
    );

    expect([settled.bonusShare, settled.realShare].map(n)).toEqual([20, 20]);
    const after = await rowOf(grantId);
    expect([after.bonusBalance, after.linkedCash, after.unlinkedCash].map(n)).toEqual([20, 20, 0]);
    expect(after.status).toBe('active');
  });
});

describe('depletion', () => {
  it('depletes a grant whose buckets are spent, but only once its open bet has settled', async () => {
    const userId = randomUUID();
    const grantId = await grant({ userId, wageringRequired: '1000' });
    const round = randomUUID();

    expect(await bet(userId, '10', '0', round)).toMatchObject({ ok: true, bonusSpent: '10' });
    expect((await rowOf(grantId)).status).toBe('active');

    expect((await lose(userId, round, '0')).completed).toEqual([]);

    expect((await rowOf(grantId)).status).toBe('depleted');
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'promo.bonus.depleted', resourceId: grantId }),
    );
  });
});

describe('forfeit and expiry', () => {
  const lifecycle = () =>
    new GrantLifecycleService(db.drizzle, makeAuditWriter(), makeEventBus(), unrestricted);

  it('removes C and releases B on an admin forfeit', async () => {
    const grantId = await grant({ buckets: { linked: '10', unlinked: '5' } });

    await lifecycle().forfeit({ grantId, reason: 'admin', note: 'abuse review' });

    const after = await rowOf(grantId);
    expect(after.status).toBe('forfeited');
    expect([after.bonusBalance, after.linkedCash, after.unlinkedCash].map(n)).toEqual([0, 0, 0]);
  });

  it('removes C and releases B on expiry', async () => {
    const grantId = await grant({ buckets: { linked: '10', unlinked: '5' } });
    await db.drizzle.db
      .update(promoGrant)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(promoGrant.id, grantId));

    await lifecycle().expireDue();

    const after = await rowOf(grantId);
    expect(after.status).toBe('expired');
    expect([after.bonusBalance, after.linkedCash, after.unlinkedCash].map(n)).toEqual([0, 0, 0]);
  });
});

describe('deposit grant', () => {
  const offers = () =>
    new OfferService(
      db.drizzle,
      makeAuditWriter(),
      grants,
      makeWalletReader(async () => ({
        activeCurrency: 'USD',
        balances: [{ currency: 'USD', balance: realBalance }],
      })),
      unrestricted,
      { error: () => undefined },
    );

  const claimOffer = async (userId: Uuid, terms: Partial<typeof promoOffer.$inferInsert>) => {
    const offer = findOneOrThrow(
      await db.drizzle.db
        .insert(promoOffer)
        .values({
          key: `offer-${randomUUID()}`,
          name: 'Welcome',
          status: 'active',
          currency: 'USD',
          matchPercent: '100',
          maxGrantAmount: '200',
          minDeposit: '10',
          terms: { wageringMultiplier: '5', expiryDays: 30 },
          rules: { firstDepositOnly: false },
          ...terms,
        })
        .returning(),
      new Error('offer insert returned no row'),
    );
    await db.drizzle.db.insert(promoOptIn).values({ userId, offerId: offer.id });
  };

  const deposit = (service: OfferService, userId: Uuid, amount: string, transactionId: Uuid) =>
    db.drizzle.db.transaction((tx) =>
      service.applyDeposit(tx, { userId, amount, currency: 'USD', transactionId }),
    );

  const grantsOf = (userId: Uuid) =>
    db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.userId, userId));

  it('grants once per deposit, with the capped match as C, the matched part as B and the rest as A', async () => {
    const userId = randomUUID();
    await claimOffer(userId, {});
    const service = offers();
    const transactionId = randomUUID();

    await deposit(service, userId, '1000', transactionId);
    await deposit(service, userId, '1000', transactionId);

    const rows = await grantsOf(userId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect([row?.bonusBalance, row?.linkedCash, row?.unlinkedCash].map(Number)).toEqual([
      200, 200, 800,
    ]);
    expect(Number(row?.wageringRequired)).toBe(1000);
    const entries = await db.drizzle.db
      .select()
      .from(promoGrantEntry)
      .where(eq(promoGrantEntry.grantId, row?.id ?? ''));
    expect(entries.map((e) => e.type)).toEqual(['grant']);
  });

  it('locks the existing real balance into A and sizes a bonus-plus-linked rollover', async () => {
    const userId = randomUUID();
    await claimOffer(userId, {
      terms: {
        wageringMultiplier: '5',
        expiryDays: 30,
        funds: {
          rolloverBase: 'bonus_plus_linked',
          existingBalance: 'locked',
          freeFundsOrder: 'last',
          dustThresholdUsd: '0.01',
          decimals: 2,
        },
      },
    });
    realBalance = '1500';

    await deposit(offers(), userId, '1000', randomUUID());

    const [row] = await grantsOf(userId);
    expect([row?.bonusBalance, row?.linkedCash, row?.unlinkedCash].map(Number)).toEqual([
      200, 200, 1300,
    ]);
    expect(Number(row?.wageringRequired)).toBe(2000);
    realBalance = '0';
  });

  it('adds a later deposit to A of the active grant', async () => {
    const userId = randomUUID();
    await claimOffer(userId, {});
    const service = offers();
    await deposit(service, userId, '100', randomUUID());

    await deposit(service, userId, '50', randomUUID());

    const [row] = await grantsOf(userId);
    expect([row?.bonusBalance, row?.linkedCash, row?.unlinkedCash].map(Number)).toEqual([
      100, 100, 50,
    ]);
  });
});
