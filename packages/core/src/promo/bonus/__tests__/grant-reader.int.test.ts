import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PlayEligibilityPort } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, makeEventBus } from '../../../testing/mock.js';
import { findOneOrThrow } from '@openora/core/server';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate } from '../migrate.js';
import { promoOffer, promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantLifecycleService } from '../service/grant-lifecycle.service.js';
import { GrantReaderService } from '../service/grant-reader.service.js';
import { GrantService } from '../service/grant.service.js';
import { WageringService } from '../service/wagering.service.js';

let db: TestDb;
let weightProfileId: string;

beforeAll(async () => {
  db = await createTestDb([migrate, identityMigrate]);
  weightProfileId = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  ).id;
  await db.drizzle.db.insert(promoWeight).values({
    profileId: weightProfileId,
    scope: 'default',
    scopeRef: null,
    contributionPercent: '100',
  });
});

afterAll(async () => {
  await db.drop();
});

describe('GrantReaderService', () => {
  it('shows the player what a grant was issued for, and only their own grants', async () => {
    const service = new GrantService(makeAuditWriter());
    const reader = new GrantReaderService(db.drizzle);
    const [mine, theirs] = [randomUUID(), randomUUID()];
    const issue = (userId: string, sourceRef: string) =>
      db.drizzle.db.transaction((tx) =>
        service.grant(tx, {
          userId,
          currency: 'USD',
          amount: '10',
          source: 'rank',
          sourceRef,
          actor: { type: 'system' },
          terms: { wageringMultiplier: '3', expiryDays: 14, weightProfileId },
        }),
      );
    await issue(mine, 'rank-daily:2026-09-28T00');
    await issue(theirs, 'rank-weekly:2026-09-21');

    const { items } = await reader.list(mine, { page: 1, limit: 10 });

    expect(items.map((grant) => grant.sourceRef)).toEqual(['rank-daily:2026-09-28T00']);
  });

  it('names the offer a grant came from, even once that offer has closed', async () => {
    const service = new GrantService(makeAuditWriter());
    const reader = new GrantReaderService(db.drizzle);
    const userId = randomUUID();
    const terms = { wageringMultiplier: '3', expiryDays: 14, weightProfileId };
    const offer = findOneOrThrow(
      await db.drizzle.db
        .insert(promoOffer)
        .values({
          key: `reload-${randomUUID()}`,
          name: 'Weekly Reload',
          status: 'paused',
          currency: 'USD',
          matchPercent: '50',
          maxGrantAmount: '100',
          minDeposit: '20',
          terms,
          rules: { firstDepositOnly: false },
        })
        .returning(),
      new Error('seed offer: query returned no row'),
    );
    const issue = (sourceRef: string, offerId?: string) =>
      db.drizzle.db.transaction((tx) =>
        service.grant(tx, {
          userId,
          currency: 'USD',
          amount: '10',
          source: offerId ? 'deposit' : 'rank',
          sourceRef,
          actor: { type: 'system' },
          terms,
          ...(offerId ? { offerId } : {}),
        }),
      );
    const fromOffer = await issue(`deposit:${randomUUID()}`, offer.id);
    await issue(`rank-daily:${randomUUID()}`);
    if (!fromOffer.ok) {
      throw new Error('seed grant refused');
    }

    const { items } = await reader.list(userId, { page: 1, limit: 10 });
    const single = await reader.get(userId, fromOffer.grantId);
    const [adminRow] = await reader.listForAdmin(userId, { page: 1, limit: 1 });

    expect(items.map(({ offerKey, offerName }) => ({ offerKey, offerName }))).toEqual(
      expect.arrayContaining([
        { offerKey: offer.key, offerName: 'Weekly Reload' },
        { offerKey: null, offerName: null },
      ]),
    );
    expect(single).toMatchObject({
      offerId: offer.id,
      offerKey: offer.key,
      offerName: 'Weekly Reload',
    });
    expect(adminRow).toHaveProperty('offerName');
  });

  it('shows the admin what a closed grant held, and nothing for a live one', async () => {
    const audit = makeAuditWriter();
    const service = new GrantService(audit);
    const lifecycle = new GrantLifecycleService(db.drizzle, audit, makeEventBus(), {
      isRestricted: async () => false,
    } satisfies PlayEligibilityPort);
    const reader = new GrantReaderService(db.drizzle);
    const userId = randomUUID();
    const issue = async (amount: string) => {
      const outcome = await db.drizzle.db.transaction((tx) =>
        service.grant(tx, {
          userId,
          currency: 'USD',
          amount,
          source: 'rank',
          sourceRef: `rank-daily:${randomUUID()}`,
          actor: { type: 'system' },
          terms: { wageringMultiplier: '3', expiryDays: 14, weightProfileId },
        }),
      );
      if (!outcome.ok) {
        throw new Error('seed grant refused');
      }
      return outcome.grantId;
    };
    const forfeited = await issue('25');
    const live = await issue('10');
    await lifecycle.forfeit({
      grantId: forfeited,
      reason: 'admin',
      actor: { id: randomUUID(), isAdmin: true },
      note: 'abuse case',
    });

    const rows = await reader.listForAdmin(userId, { page: 1, limit: 10 });

    expect(rows.find((row) => row.id === forfeited)).toMatchObject({
      status: 'forfeited',
      bonusBalance: '0.000000000000000000',
      closedAmount: '25.000000000000000000',
    });
    expect(rows.find((row) => row.id === live)?.closedAmount).toBeNull();
  });

  describe('max bet', () => {
    const issue = async (userId: string, amount: string, terms: object, currency = 'USD') => {
      const outcome = await db.drizzle.db.transaction((tx) =>
        new GrantService(makeAuditWriter()).grant(tx, {
          userId,
          currency,
          amount,
          source: 'deposit',
          sourceRef: randomUUID(),
          actor: { type: 'system' },
          terms: { wageringMultiplier: '3', expiryDays: 14, weightProfileId, ...terms },
        }),
      );
      if (!outcome.ok) {
        throw new Error('seed grant refused');
      }
      return outcome.grantId;
    };

    it('shows the max bet resolved at grant time on the grant, and null when it has none', async () => {
      const reader = new GrantReaderService(db.drizzle);
      const userId = randomUUID();
      const limited = await issue(userId, '200', { maxBetRate: '0.05' });
      const unlimited = await issue(userId, '50', {});

      const { items } = await reader.list(userId, { page: 1, limit: 10 });
      const single = await reader.get(userId, limited);

      expect(Number(items.find((g) => g.id === limited)?.maxBet)).toBe(10);
      expect(items.find((g) => g.id === unlimited)?.maxBet).toBeNull();
      expect(Number(single.maxBet)).toBe(10);
    });

    it('shows the balance the max bet of the grant a bet in that currency is attributed to', async () => {
      const reader = new GrantReaderService(db.drizzle);
      const userId = randomUUID();
      await issue(userId, '100', { maxBet: '4' });
      await issue(userId, '100', { maxBet: '9', expiryDays: 90 });
      await issue(userId, '100', {}, 'EUR');

      const balances = await reader.balances(userId);

      expect(Number(balances.find((b) => b.currency === 'USD')?.maxBet)).toBe(4);
      expect(balances.find((b) => b.currency === 'EUR')?.maxBet).toBeNull();
    });

    it('shows no max bet for a player with no active grant', async () => {
      const reader = new GrantReaderService(db.drizzle);

      expect(await reader.balances(randomUUID())).toEqual([]);
    });
  });

  it('shows progress open rounds hold as pending, and moves it into progress once they settle', async () => {
    const service = new GrantService(makeAuditWriter());
    const wagering = new WageringService(makeAuditWriter());
    const reader = new GrantReaderService(db.drizzle);
    const userId = randomUUID();
    const issued = await db.drizzle.db.transaction((tx) =>
      service.grant(tx, {
        userId,
        currency: 'USD',
        amount: '100',
        source: 'deposit',
        sourceRef: randomUUID(),
        actor: { type: 'system' },
        terms: { wageringMultiplier: '5', expiryDays: 14, weightProfileId },
      }),
    );
    if (!issued.ok) {
      throw new Error('grant was refused');
    }
    const round = { providerName: 'aggregator', externalRoundId: randomUUID() };
    const read = async () => {
      const own = await reader.get(userId, issued.grantId);
      const staff = await reader.getForAdmin(issued.grantId);
      return [own, staff].map((g) => [Number(g.pendingWagered), Number(g.wageringProgress)]);
    };
    expect(await read()).toEqual([
      [0, 0],
      [0, 0],
    ]);

    await db.drizzle.db.transaction((tx) =>
      wagering.wager(tx, {
        userId,
        currency: 'USD',
        stake: '30',
        realAvailable: '0',
        context: { provider: 'aggregator', product: 'casino' },
        ...round,
      }),
    );
    expect(await read()).toEqual([
      [30, 0],
      [30, 0],
    ]);

    await db.drizzle.db.transaction((tx) =>
      wagering.closeRound(tx, { userId, currency: 'USD', realBalance: '0', ...round }),
    );
    expect(await read()).toEqual([
      [0, 30],
      [0, 30],
    ]);
  });
});
