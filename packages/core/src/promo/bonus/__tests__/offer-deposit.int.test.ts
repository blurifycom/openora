import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { PlayEligibilityPort, Uuid, WalletReader } from '@openora/core/contracts';
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
import { seedDefaultWeightProfile } from '../seed/index.js';
import { GrantService } from '../service/grant.service.js';
import { InvalidOfferTermsError, OfferService } from '../service/offer.service.js';
import { BonusSlotTakenError } from '../shared/grant-slot.js';

let db: TestDb;
let offers: OfferService;
let singleSlotOffers: OfferService;
let lifetimeDeposit = '0';
let firstDepositOverride: boolean | undefined;
let restricted = false;
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
    isFirstDeposit: vi.fn(async () => firstDepositOverride ?? false),
  });
  const playEligibility = mock<PlayEligibilityPort>({
    isRestricted: vi.fn(async () => restricted),
  });
  offers = new OfferService(
    db.drizzle,
    makeAuditWriter(),
    new GrantService(makeAuditWriter()),
    wallet,
    playEligibility,
    { error: (context) => logged.push(context) },
  );
  singleSlotOffers = new OfferService(
    db.drizzle,
    makeAuditWriter(),
    new GrantService(makeAuditWriter(), 'single'),
    wallet,
    playEligibility,
    { error: (context) => logged.push(context) },
    'single',
  );
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${promoOptInDeposit}, ${promoOptIn}, ${promoGrant}, ${promoOffer}, ${promoWeight}, ${promoWeightProfile} CASCADE`,
  );
  await seedDefaultWeightProfile(db.drizzle.db);
  logged.length = 0;
  lifetimeDeposit = '0';
  firstDepositOverride = undefined;
  restricted = false;
});

describe('a deposit applied to a claim', () => {
  it('counts a deposit short of the minimum toward nothing', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100' });
    await claim(userId, offer.id);
    lifetimeDeposit = '60';

    await apply(userId, '60', randomUUID());

    const [optIn] = await optInsOf(userId);
    expect(optIn?.accumulatedDeposit).toBe('0.000000000000000000');
    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('grants nothing on two deposits that only clear the minimum together', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100', matchPercent: '50' });
    await claim(userId, offer.id);
    lifetimeDeposit = '60';
    await apply(userId, '60', randomUUID());
    lifetimeDeposit = '120';

    await apply(userId, '60', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('grants once on a deposit that clears the minimum, however many times the job runs', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '100', matchPercent: '50' });
    await claim(userId, offer.id);
    const transactionId = randomUUID();
    lifetimeDeposit = '120';

    await apply(userId, '120', transactionId);
    await apply(userId, '120', transactionId);

    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantedAmount).toBe('60.000000000000000000');
    const [optIn] = await optInsOf(userId);
    expect(optIn?.accumulatedDeposit).toBe('120.000000000000000000');
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

  it('pays a period-close offer nothing on a deposit, opted in or automatic', async () => {
    const userId = randomUUID();
    const periodClose = { firstDepositOnly: false, periodDays: 7 };
    const optedIn = await seedOffer({ minDeposit: '0', rules: periodClose });
    await claim(userId, optedIn.id);
    await seedOffer({ minDeposit: '0', requiresOptIn: false, rules: periodClose });
    lifetimeDeposit = '2000';

    await apply(userId, '2000', randomUUID());

    const optIns = await optInsOf(userId);
    expect(optIns).toHaveLength(1);
    expect(optIns[0]?.accumulatedDeposit).toBe('0.000000000000000000');
    expect(await db.drizzle.db.select().from(promoOptInDeposit)).toHaveLength(0);
    expect(await grantsOf(userId)).toHaveLength(0);
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

  it('trusts isFirstDeposit over a lifetime total inflated by a later deposit processed first', async () => {
    // A second deposit's job ran first, so the running lifetime total already includes it -
    // comparing it against this (earlier) deposit's own amount would wrongly say "not first".
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '20', rules: { firstDepositOnly: true } });
    await claim(userId, offer.id);
    lifetimeDeposit = '150'; // this deposit (50) plus a later one (100) already summed in
    firstDepositOverride = true; // the immutable fact: this transaction really was first

    await apply(userId, '50', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(1);
  });

  it('does not open an automatic claim on an offer in a currency this deposit cannot satisfy', async () => {
    const userId = randomUUID();
    const eurOffer = await seedOffer({
      currency: 'EUR',
      requiresOptIn: false,
      minDeposit: '10',
    });
    lifetimeDeposit = '50';

    await apply(userId, '50', randomUUID(), 'USD');

    expect(await optInsOf(userId)).toHaveLength(0);

    // Re-denominating the EUR offer is still possible: no claim was ever opened against it.
    await db.drizzle.db
      .update(promoOffer)
      .set({ currency: 'GBP' })
      .where(eq(promoOffer.id, eurOffer.id));
    const [after] = await db.drizzle.db
      .select()
      .from(promoOffer)
      .where(eq(promoOffer.id, eurOffer.id));
    expect(after?.currency).toBe('GBP');
  });

  it('serializes an opt-in against a concurrent offer edit holding the row lock', async () => {
    const offer = await seedOffer({ minDeposit: '0' });
    const userId = randomUUID();
    let lockReleasedAt = 0;

    const holder = db.drizzle.db.transaction(async (tx) => {
      await tx.select().from(promoOffer).where(eq(promoOffer.id, offer.id)).for('update');
      await new Promise((resolve) => setTimeout(resolve, 150));
      lockReleasedAt = Date.now();
    });
    // Give the holder a head start so it is the one to acquire the lock first.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await offers.optIn(userId, offer.id);
    const optInResolvedAt = Date.now();
    await holder;

    expect(optInResolvedAt).toBeGreaterThanOrEqual(lockReleasedAt);
  });

  it('refuses to open a claim for a restricted player', async () => {
    const offer = await seedOffer({ minDeposit: '0' });
    const userId = randomUUID();
    restricted = true;

    await expect(offers.optIn(userId, offer.id)).rejects.toThrow();

    expect(await optInsOf(userId)).toHaveLength(0);
  });

  it('re-evaluates eligibility at credit time: a restricted player earns no grant', async () => {
    // ELG-07. The deposit itself is the wallet's concern and already committed before this job
    // runs - applyDeposit only ever decides the bonus, never the real-balance credit.
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '20', matchPercent: '50' });
    await claim(userId, offer.id);
    lifetimeDeposit = '50';
    restricted = true;

    await apply(userId, '50', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('closes the race: a delayed deposit job running after self-exclusion grants nothing', async () => {
    // The opt-in and the deposit both happened while the player was still eligible; only this
    // job - delayed behind the forfeit sweep that already ran and found no grant to forfeit -
    // processes after the exclusion landed. The forfeit sweep has no way to know a grant would
    // appear later; re-checking eligibility here, rather than trusting the state at opt-in time,
    // is what closes that window.
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '20', matchPercent: '100' });
    await claim(userId, offer.id);
    lifetimeDeposit = '100';
    restricted = true; // the exclusion that landed before this delayed job runs

    await apply(userId, '100', randomUUID());

    expect(await grantsOf(userId)).toHaveLength(0);
  });
});

describe('an offer with a max bet rate', () => {
  it('grants a bonus with the limit resolved from the credited bonus amount', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({
      minDeposit: '20',
      terms: {
        wageringMultiplier: '5',
        expiryDays: 30,
        maxBetRate: '0.1',
        maxBetFloor: '2',
        maxBetCeiling: '25',
        maxBetExemptProducts: ['pvp'],
      },
    });
    await claim(userId, offer.id);
    lifetimeDeposit = '100';

    await apply(userId, '100', randomUUID());

    const [grant] = await grantsOf(userId);
    expect(Number(grant?.terms.maxBet)).toBe(10);
    expect(grant?.terms.maxBetExemptProducts).toEqual(['pvp']);
  });

  it('refuses to save an offer whose floor is above its ceiling', async () => {
    const terms = {
      wageringMultiplier: '5',
      expiryDays: 30,
      maxBetRate: '0.1',
      maxBetFloor: '30',
      maxBetCeiling: '25',
    };

    await expect(
      offers.create(randomUUID(), {
        key: `offer-${randomUUID()}`,
        name: 'Bad limits',
        status: 'draft',
        currency: 'USD',
        matchPercent: '100',
        maxGrantAmount: '1000',
        minDeposit: '20',
        terms,
        rules: { firstDepositOnly: false },
        requiresOptIn: true,
        validFrom: null,
        validUntil: null,
      }),
    ).rejects.toBeInstanceOf(InvalidOfferTermsError);
    const saved = await seedOffer();
    await expect(offers.update(randomUUID(), { id: saved.id, terms })).rejects.toBeInstanceOf(
      InvalidOfferTermsError,
    );
  });
});

describe('the offer lists', () => {
  it('marks an offer claimed once a deposit turned it into a bonus', async () => {
    const userId = randomUUID();
    const [granting, pending] = [await seedOffer({ minDeposit: '20' }), await seedOffer()];
    await claim(userId, granting.id);
    await claim(userId, pending.id);
    lifetimeDeposit = '50';
    await apply(userId, '50', randomUUID());

    const listed = await offers.listForPlayer(userId);

    expect(listed.find((o) => o.id === granting.id)).toMatchObject({
      optedIn: true,
      claimed: true,
    });
    expect(listed.find((o) => o.id === pending.id)).toMatchObject({
      optedIn: true,
      claimed: false,
    });
  });

  it('shows a visitor the live deal and nothing a player or operator owns', async () => {
    const live = await seedOffer({ rules: { firstDepositOnly: true } });
    await seedOffer({ status: 'draft' });
    await seedOffer({ validUntil: new Date(Date.now() - 60_000) });
    await claim(randomUUID(), live.id);

    const listed = await offers.listPublic();

    expect(listed).toEqual([
      {
        id: live.id,
        key: live.key,
        name: live.name,
        currency: 'USD',
        matchPercent: '100.00',
        maxGrantAmount: '1000.000000000000000000',
        minDeposit: '100.000000000000000000',
        requiresOptIn: true,
        validUntil: null,
        wageringMultiplier: '5',
      },
    ]);
  });
});

describe('a deposit bonus under a single-grant slot', () => {
  const holdSlot = async (userId: Uuid, currency = 'USD') => {
    const outcome = await db.drizzle.db.transaction((tx) =>
      new GrantService(makeAuditWriter()).grant(tx, {
        userId,
        currency,
        amount: '10',
        source: 'streak',
        sourceRef: randomUUID(),
        actor: { type: 'system' },
      }),
    );
    if (!outcome.ok) {
      throw new Error('holdSlot: grant refused');
    }
    return outcome.grantId;
  };

  const applySingle = (userId: Uuid, amount: string) =>
    db.drizzle.db.transaction((tx) =>
      singleSlotOffers.applyDeposit(tx, {
        userId,
        amount,
        currency: 'USD',
        transactionId: randomUUID(),
      }),
    );

  it('refuses the opt-in up front while another bonus holds the slot', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '0' });
    await holdSlot(userId);

    await expect(singleSlotOffers.optIn(userId, offer.id)).rejects.toBeInstanceOf(
      BonusSlotTakenError,
    );
    expect(await optInsOf(userId)).toHaveLength(0);
  });

  it('accepts the opt-in when the held bonus is in another currency', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '0' });
    await holdSlot(userId, 'EUR');

    await singleSlotOffers.optIn(userId, offer.id);

    expect(await optInsOf(userId)).toHaveLength(1);
  });

  it('pays no bonus on a deposit landing after another bonus took the slot, and keeps the claim open', async () => {
    const userId = randomUUID();
    const offer = await seedOffer({ minDeposit: '20', matchPercent: '50' });
    await claim(userId, offer.id);
    const holder = await holdSlot(userId);
    lifetimeDeposit = '100';

    const granted = await applySingle(userId, '100');

    expect(granted).toEqual([]);
    expect((await grantsOf(userId)).map((g) => g.id)).toEqual([holder]);
    const [optIn] = await optInsOf(userId);
    expect(optIn).toMatchObject({ grantId: null, accumulatedDeposit: '0.000000000000000000' });
    expect(logged).toEqual([]);

    // The slot frees up; the next deposit is matched on its own amount.
    await db.drizzle.db
      .update(promoGrant)
      .set({ status: 'expired' })
      .where(eq(promoGrant.id, holder));
    lifetimeDeposit = '140';
    const next = await applySingle(userId, '40');

    expect(next).toHaveLength(1);
    expect(next[0]?.grantedAmount).toBe('20.000000000000000000');
  });
});
