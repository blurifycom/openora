import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { findOneOrThrow, uniqueConstraintName, type DrizzleTx } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { Uuid } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { BonusService } from '../service/bonus.service.js';

let db: TestDb;
let service: BonusService;
let profileId: Uuid;

const CASINO = { provider: 'aggregator', product: 'casino' };

async function seedProfile() {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seedProfile: query returned no row'),
  );
  return row.id as Uuid;
}

async function seedWeight(
  scope: (typeof promoWeight.$inferInsert)['scope'],
  scopeRef: string | null,
  contributionPercent: string,
  owner: Uuid = profileId,
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeight)
      .values({ profileId: owner, scope, scopeRef, contributionPercent })
      .returning(),
    new Error('seedWeight: query returned no row'),
  );
}

const weigh = (
  stake: string,
  context: Parameters<BonusService['weightedContribution']>[1]['context'],
) =>
  service.weightedContribution(db.drizzle.db as unknown as DrizzleTx, {
    profileId,
    stake,
    context,
  });

beforeAll(async () => {
  db = await createTestDb([migrate]);
  service = new BonusService();
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${promoWeight}, ${promoWeightProfile} RESTART IDENTITY CASCADE`,
  );
  profileId = await seedProfile();
});

describe('BonusService.weightedContribution (real PG)', () => {
  it('WGR-01: scores a casino bet at the product weight', async () => {
    await seedWeight('product', 'casino', '100');

    expect(await weigh('100', CASINO)).toEqual({
      contributionPercent: '100.000000000000000000',
      weightedAmount: '100.000000000000000000',
    });
  });

  it('WGR-07: prefers the game row over the category, product and default rows', async () => {
    await seedWeight('default', null, '10');
    await seedWeight('product', 'casino', '20');
    await seedWeight('category', 'slots', '30');
    await seedWeight('game', 'game-a', '40');

    const { weightedAmount } = await weigh('100', {
      ...CASINO,
      categorySlug: 'slots',
      gameId: 'game-a',
    });

    expect(weightedAmount).toBe('40.000000000000000000');
  });

  it('WGR-05: falls through to the product weight when the game is unresolved', async () => {
    await seedWeight('product', 'casino', '100');
    await seedWeight('game', 'game-a', '50');

    expect((await weigh('100', CASINO)).weightedAmount).toBe('100.000000000000000000');
  });

  it('WGR-03: scores a PvP bet at zero', async () => {
    await seedWeight('product', 'casino', '100');
    await seedWeight('product', 'pvp', '0');

    expect((await weigh('100', { ...CASINO, product: 'pvp' })).weightedAmount).toBe(
      '0.000000000000000000',
    );
  });

  it('scores at zero when the profile holds no matching row', async () => {
    expect((await weigh('100', CASINO)).weightedAmount).toBe('0.000000000000000000');
  });

  it('reads only its own profile, so two profiles can weight the same game differently', async () => {
    const other = await seedProfile();
    await seedWeight('product', 'casino', '100');
    await seedWeight('product', 'casino', '25', other);

    expect((await weigh('100', CASINO)).weightedAmount).toBe('100.000000000000000000');
  });
});

describe('promo_weight guards (real PG)', () => {
  const violatedIndex = async (insert: Promise<unknown>) =>
    insert.then(
      () => null,
      (e: unknown) => uniqueConstraintName(e),
    );

  it('rejects a second row for the same target in one profile', async () => {
    await seedWeight('product', 'casino', '100');

    expect(await violatedIndex(seedWeight('product', 'casino', '50'))).toBe(
      'promo_weight_profile_id_scope_scope_ref_index',
    );
  });

  it('rejects a second default row, which null handling would otherwise let through', async () => {
    await seedWeight('default', null, '10');

    expect(await violatedIndex(seedWeight('default', null, '20'))).toBe(
      'promo_weight_profile_id_index',
    );
  });

  it('allows the same target in a different profile', async () => {
    const other = await seedProfile();
    await seedWeight('product', 'casino', '100');

    await expect(seedWeight('product', 'casino', '50', other)).resolves.toBeDefined();
  });

  it('deletes a profile together with its weights, leaving no orphan row', async () => {
    await seedWeight('product', 'casino', '100');

    await db.drizzle.db.delete(promoWeightProfile);

    expect(await db.drizzle.db.select().from(promoWeight)).toHaveLength(0);
  });
});
