import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, seedUser, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { PlayEligibilityService } from '../service/play-eligibility.service.js';

const HOUR_MS = 60 * 60 * 1000;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('PlayEligibilityService.isRestricted reads the stored RG block (real PG)', () => {
  it.each([
    ['an indefinitely blocked player', { rgBlocked: true, rgBlockedUntil: null }, true],
    [
      'a cooling-off still in its window',
      { rgBlocked: true, rgBlockedUntil: new Date(Date.now() + HOUR_MS) },
      true,
    ],
    [
      'an elapsed cooling-off before the expiry sweep runs',
      { rgBlocked: true, rgBlockedUntil: new Date(Date.now() - HOUR_MS) },
      false,
    ],
    ['an unblocked player', { rgBlocked: false, rgBlockedUntil: null }, false],
  ])('reports %s as restricted=%s', async (_label, state, restricted) => {
    const account = await seedUser(db, state);
    const svc = new PlayEligibilityService(db.drizzle);

    expect(await svc.isRestricted(account.id)).toBe(restricted);
  });

  it('fails closed for an unknown user', async () => {
    const svc = new PlayEligibilityService(db.drizzle);

    expect(await svc.isRestricted(randomUUID())).toBe(true);
  });
});
