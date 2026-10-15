import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { findOneOrThrow } from '@openora/core/server';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate } from '../migrate.js';
import { promoOffer, promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantLifecycleService } from '../service/grant-lifecycle.service.js';
import { GrantReaderService } from '../service/grant-reader.service.js';
import { GrantService } from '../service/grant.service.js';

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
    const lifecycle = new GrantLifecycleService(db.drizzle, audit);
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
    await lifecycle.forfeit(forfeited, 'admin', { id: randomUUID(), isAdmin: true }, 'abuse case');

    const rows = await reader.listForAdmin(userId, { page: 1, limit: 10 });

    expect(rows.find((row) => row.id === forfeited)).toMatchObject({
      status: 'forfeited',
      bonusBalance: '0.000000000000000000',
      closedAmount: '25.000000000000000000',
    });
    expect(rows.find((row) => row.id === live)?.closedAmount).toBeNull();
  });
});
