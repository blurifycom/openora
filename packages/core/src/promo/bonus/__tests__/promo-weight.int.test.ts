import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { findOneOrThrow, uniqueConstraintName } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { Uuid } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { promoWeight, promoWeightProfile } from '../schema/index.js';
import { resolveContributionPercent, weightedStake } from '../shared/wagering-weight.js';

let db: TestDb;
let profileId: Uuid;

const CASINO = { provider: 'aggregator', product: 'casino' };

async function seedProfile(): Promise<Uuid> {
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

const rowsOf = (owner: Uuid = profileId) =>
  db.drizzle.db
    .select({
      scope: promoWeight.scope,
      scopeRef: promoWeight.scopeRef,
      contributionPercent: promoWeight.contributionPercent,
    })
    .from(promoWeight)
    .where(eq(promoWeight.profileId, owner));

const violatedIndex = async (insert: Promise<unknown>) =>
  insert.then(
    () => null,
    (e: unknown) => uniqueConstraintName(e),
  );

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(promoWeight);
  await db.drizzle.db.delete(promoWeightProfile);
  profileId = await seedProfile();
});

describe('wagering weights stored in Postgres', () => {
  it('scores a casino bet at the stored product weight', async () => {
    await seedWeight('product', 'casino', '100');

    const percent = resolveContributionPercent(await rowsOf(), CASINO);
    expect(percent).toBe('100.00');
    expect(weightedStake('100', percent)).toBe('100.000000000000000000');
  });

  it('prefers the game row over the category, product and default rows', async () => {
    await seedWeight('default', null, '10');
    await seedWeight('product', 'casino', '20');
    await seedWeight('category', 'slots', '30');
    await seedWeight('game', 'game-a', '40');

    const percent = resolveContributionPercent(await rowsOf(), {
      ...CASINO,
      categorySlug: 'slots',
      gameId: 'game-a',
    });
    expect(weightedStake('100', percent)).toBe('40.000000000000000000');
  });

  it('falls through to the product weight when the game is unresolved', async () => {
    await seedWeight('product', 'casino', '100');
    await seedWeight('game', 'game-a', '50');

    expect(weightedStake('100', resolveContributionPercent(await rowsOf(), CASINO))).toBe(
      '100.000000000000000000',
    );
  });

  it('scores a bet at zero when the profile holds no matching row', async () => {
    expect(weightedStake('100', resolveContributionPercent(await rowsOf(), CASINO))).toBe(
      '0.000000000000000000',
    );
  });

  it('reads only its own profile, so two profiles can weight the same game differently', async () => {
    const other = await seedProfile();
    await seedWeight('product', 'casino', '100');
    await seedWeight('product', 'casino', '25', other);

    expect(weightedStake('100', resolveContributionPercent(await rowsOf(other), CASINO))).toBe(
      '25.000000000000000000',
    );
  });
});

describe('promo_weight guards', () => {
  it('rejects a second row for the same target in one profile', async () => {
    await seedWeight('product', 'casino', '100');

    expect(await violatedIndex(seedWeight('product', 'casino', '50'))).toBe(
      'promo_weight_profile_id_scope_scope_ref_idx',
    );
  });

  it('rejects a second default row, which null handling would otherwise let through', async () => {
    await seedWeight('default', null, '10');

    expect(await violatedIndex(seedWeight('default', null, '20'))).toBe(
      'promo_weight_profile_id_default_idx',
    );
  });

  it('rejects a weight above one hundred percent', async () => {
    await expect(seedWeight('product', 'casino', '500')).rejects.toThrow();
  });

  it('rejects a negative weight', async () => {
    await expect(seedWeight('product', 'casino', '-1')).rejects.toThrow();
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
