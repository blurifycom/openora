import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { findOneOrThrow } from '@openora/core/server';
import { migrate } from '../migrate.js';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantReaderService } from '../service/grant-reader.service.js';
import { GrantService } from '../service/grant.service.js';

let db: TestDb;
let weightProfileId: string;

beforeAll(async () => {
  db = await createTestDb([migrate]);
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
});
