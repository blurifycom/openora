import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { Uuid, WalletReader } from '@openora/core/contracts';
import { mock, makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  promoGrant,
  promoOffer,
  promoOptIn,
  promoOptInDeposit,
  promoWeight,
  promoWeightProfile,
} from '../schema/index.js';
import { GrantService } from '../service/grant.service.js';
import { OfferService } from '../service/offer.service.js';

let db: TestDb;
let offers: OfferService;
let lifetimeDeposit = '0';
const logged: object[] = [];

const offerRow = (over: Partial<typeof promoOffer.$inferInsert> = {}) => ({
  key: `offer-${randomUUID()}`,
  name: 'Sign-Up Bonus',
  status: 'active' as const,
  currency: 'USD',
  matchPercent: '100',
  maxGrantAmount: '1000',
  minDeposit: '100',
  terms: { wageringMultiplier: '5', expiryDays: 30 },
  rules: { firstDepositOnly: false },
  requiresOptIn: true,
  ...over,
});

const seedOffer = async (over: Partial<typeof promoOffer.$inferInsert> = {}) =>
  findOneOrThrow(
    await db.drizzle.db.insert(promoOffer).values(offerRow(over)).returning(),
    new Error('seedOffer: query returned no row'),
  );

const claim = async (userId: Uuid, offerId: Uuid) =>
  findOneOrThrow(
    await db.drizzle.db.insert(promoOptIn).values({ userId, offerId }).returning(),
    new Error('claim: query returned no row'),
  );

const apply = (userId: Uuid, amount: string, transactionId: Uuid, currency = 'USD') =>
  db.drizzle.db.transaction((tx) =>
    offers.applyDeposit(tx, { userId, amount, currency, transactionId }),
  );

const optInsOf = (userId: Uuid) =>
  db.drizzle.db.select().from(promoOptIn).where(eq(promoOptIn.userId, userId));

const grantsOf = (userId: Uuid) =>
  db.drizzle.db.select().from(promoGrant).where(eq(promoGrant.userId, userId));

beforeAll(async () => {
  db = await createTestDb([migrate]);
  const wallet = mock<WalletReader>({
    getLifetimeDeposit: vi.fn(async () => lifetimeDeposit),
  });
  offers = new OfferService(
    db.drizzle,
    makeAuditWriter(),
    new GrantService(makeAuditWriter()),
    wallet,
    { error: (context) => logged.push(context) },
  );
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${promoOptInDeposit}, ${promoOptIn}, ${promoGrant}, ${promoOffer}, ${promoWeight}, ${promoWeightProfile} CASCADE`,
  );
  await db.drizzle.db.insert(promoWeightProfile).values({ name: 'default' }).onConflictDoNothing();
  logged.length = 0;
  lifetimeDeposit = '0';
});

describe('a deposit applied to a claim', () => {
  it('banks a deposit short of the minimum', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100' });
    await claim(userId, offer.id);
    lifetimeDeposit = '60';

    await apply(userId, '60', randomUUID());

    const [optIn] = await optInsOf(userId);
    expect(optIn?.accumulatedDeposit).toBe('60.000000000000000000');
    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('counts the same deposit once, however many times the job runs', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100' });
    await claim(userId, offer.id);
    const transactionId = randomUUID();
    lifetimeDeposit = '60';

    await apply(userId, '60', transactionId);
    await apply(userId, '60', transactionId);

    const [optIn] = await optInsOf(userId);
    expect(optIn?.accumulatedDeposit).toBe('60.000000000000000000');
    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('grants once the banked deposits clear the minimum', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100', matchPercent: '50' });
    await claim(userId, offer.id);
    lifetimeDeposit = '60';
    await apply(userId, '60', randomUUID());
    lifetimeDeposit = '120';

    await apply(userId, '60', randomUUID());

    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantedAmount).toBe('60.000000000000000000');
  });

  it('banks nothing while the offer is paused, so re-activating pays no back-match', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100', status: 'paused' });
    await claim(userId, offer.id);
    lifetimeDeposit = '900';

    await apply(userId, '900', randomUUID());

    const [optIn] = await optInsOf(userId);
    expect(optIn?.accumulatedDeposit).toBe('0.000000000000000000');

    await db.drizzle.db
      .update(promoOffer)
      .set({ status: 'active' })
      .where(eq(promoOffer.id, offer.id));
    lifetimeDeposit = '1000';
    await apply(userId, '100', randomUUID());

    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantedAmount).toBe('100.000000000000000000');
  });

  it('gives each offer its own grant when one deposit satisfies two claims', async () => {
    const userId = randomUUID();
    const first = await seedOffer({ minDeposit: '20', matchPercent: '100', maxGrantAmount: '500' });
    const second = await seedOffer({ minDeposit: '20', matchPercent: '50', maxGrantAmount: '500' });
    await claim(userId, first.id);
    await claim(userId, second.id);
    lifetimeDeposit = '100';

    await apply(userId, '100', randomUUID());

    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.grantedAmount).sort()).toEqual([
      '100.000000000000000000',
      '50.000000000000000000',
    ]);
  });

  it('skips a deposit whose match truncates to nothing rather than failing the batch', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '0', matchPercent: '0.01' });
    await claim(userId, offer.id);
    lifetimeDeposit = '0.000000000000000001';

    await apply(userId, '0.000000000000000001', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('opens a claim on an offer that needs no taking', async () => {
    const userId = randomUUID();
    await seedOffer({ minDeposit: '20', requiresOptIn: false });
    lifetimeDeposit = '50';

    await apply(userId, '50', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(1);
  });

  it('ignores a deposit in another currency', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '20', currency: 'USD' });
    await claim(userId, offer.id);
    lifetimeDeposit = '50';

    await apply(userId, '50', randomUUID(), 'EUR');

    const [optIn] = await optInsOf(userId);
    expect(optIn?.accumulatedDeposit).toBe('0.000000000000000000');
    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('grants a first-deposit-only offer only on the first deposit', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '20', rules: { firstDepositOnly: true } });
    await claim(userId, offer.id);
    lifetimeDeposit = '500';

    await apply(userId, '50', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(0);
  });
});
