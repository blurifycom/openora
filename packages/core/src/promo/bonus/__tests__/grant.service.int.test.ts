import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { BonusGrantArgs, Uuid } from '@openora/core/contracts';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry, promoWeight, promoWeightProfile } from '../schema/index.js';
import { GrantService } from '../service/grant.service.js';
import { resolveContributionPercent, weightedStake } from '../shared/wagering-weight.js';

let db: TestDb;
let service: GrantService;
let audit: ReturnType<typeof makeAuditWriter>;
let weightProfileId: Uuid;

const CASINO = { provider: 'aggregator', product: 'casino' } as const;

const termsWith = (wageringMultiplier: string, expiryDays = 30) => ({
  wageringMultiplier,
  expiryDays,
  weightProfileId,
});

const args = (over: Partial<BonusGrantArgs> = {}): BonusGrantArgs => ({
  userId: randomUUID(),
  currency: 'USD',
  amount: '100',
  source: 'deposit',
  sourceRef: randomUUID(),
  actor: { type: 'system' },
  terms: termsWith('35'),
  ...over,
});

const grant = (a: BonusGrantArgs) => db.drizzle.db.transaction((tx) => service.grant(tx, a));

const rows = () => db.drizzle.db.select().from(promoGrant);

const entries = () => db.drizzle.db.select().from(promoGrantEntry);

const ledgerSum = async (grantId: string): Promise<string> => {
  const [row] = await db.drizzle.db
    .select({ total: sql<string>`coalesce(sum(${promoGrantEntry.bonusAmount}), 0)::text` })
    .from(promoGrantEntry)
    .where(eq(promoGrantEntry.grantId, grantId));
  return row?.total ?? '0';
};

const seedWeight = (
  scope: (typeof promoWeight.$inferInsert)['scope'],
  scopeRef: string | null,
  contributionPercent: string,
) =>
  db.drizzle.db
    .insert(promoWeight)
    .values({ profileId: weightProfileId, scope, scopeRef, contributionPercent });

const scoreOf = (terms: (typeof promoGrant.$inferSelect)['terms'], stake: string) =>
  weightedStake(stake, resolveContributionPercent(terms.weights, CASINO));

beforeAll(async () => {
  db = await createTestDb([migrate]);
  audit = makeAuditWriter();
  service = new GrantService(audit);
});

afterAll(async () => {
  await db.drop();
});

// Test cleanup needs to delete ledger rows between cases; the append-only trigger and the
// balance-matches-the-ledger constraint trigger that production relies on would both refuse
// it (the latter because the parent grant row, deleted next, is still there mid-cleanup), so
// cleanup lifts both for exactly this statement.
const wipeLedger = async () => {
  await db.drizzle.db.execute(
    sql`ALTER TABLE promo_grant_entry DISABLE TRIGGER promo_grant_entry_append_only, DISABLE TRIGGER promo_grant_entry_balance_matches_ledger`,
  );
  try {
    await db.drizzle.db.delete(promoGrantEntry);
  } finally {
    await db.drizzle.db.execute(
      sql`ALTER TABLE promo_grant_entry ENABLE TRIGGER promo_grant_entry_append_only, ENABLE TRIGGER promo_grant_entry_balance_matches_ledger`,
    );
  }
};

beforeEach(async () => {
  await wipeLedger();
  await db.drizzle.db.delete(promoGrant);
  await db.drizzle.db.delete(promoWeight);
  await db.drizzle.db.delete(promoWeightProfile);
  vi.clearAllMocks();
  weightProfileId = findOneOrThrow(
    await db.drizzle.db
      .insert(promoWeightProfile)
      .values({ name: `profile-${randomUUID()}` })
      .returning(),
    new Error('seed profile: query returned no row'),
  ).id;
  // A profile with no positive weight can never progress a grant's wagering requirement, so
  // the fixture always carries a usable default; the empty/unusable case gets its own profile.
  await seedWeight('default', null, '100');
});

describe('GrantService.grant', () => {
  it('credits the bonus and derives the requirement from the multiplier', async () => {
    const outcome = await grant(args({ amount: '100', terms: termsWith('35') }));

    expect(outcome).toMatchObject({ ok: true, created: true });
    const [row] = await rows();
    expect(row).toMatchObject({
      grantedAmount: '100.000000000000000000',
      bonusBalance: '100.000000000000000000',
      wageringRequired: '3500.000000000000000000',
      wageringProgress: '0.000000000000000000',
      status: 'active',
    });
    expect(row?.activatedAt).toBeInstanceOf(Date);
    expect(row?.closedAt).toBeNull();
  });

  it('uppercases the currency, so a lowercase caller cannot hide a grant from its own bets', async () => {
    await grant(args({ currency: 'usd' }));

    const [row] = await rows();
    expect(row?.currency).toBe('USD');
  });

  it('snapshots the terms and the profile weights onto the grant', async () => {
    await seedWeight('product', 'casino', '100');
    await grant(args({ terms: termsWith('35', 7) }));

    const [row] = await rows();
    expect(row?.terms).toEqual({
      wageringMultiplier: '35',
      expiryDays: 7,
      weightProfileId,
      weights: expect.arrayContaining([
        { scope: 'product', scopeRef: 'casino', contributionPercent: '100.00' },
      ]),
    });
  });

  it('keeps scoring a granted bonus at its snapshot after the profile is edited', async () => {
    await seedWeight('product', 'casino', '100');
    await grant(args());
    await db.drizzle.db
      .update(promoWeight)
      .set({ contributionPercent: '10' })
      .where(eq(promoWeight.profileId, weightProfileId));

    const [row] = await rows();
    expect(scoreOf(row!.terms, '50')).toBe('50.000000000000000000');
  });

  it('keeps scoring a granted bonus at its snapshot after the profile is deleted', async () => {
    await seedWeight('product', 'casino', '100');
    await grant(args());
    await db.drizzle.db
      .delete(promoWeightProfile)
      .where(eq(promoWeightProfile.id, weightProfileId));

    const [row] = await rows();
    expect(scoreOf(row!.terms, '50')).toBe('50.000000000000000000');
  });

  it('refuses a grant on a weight profile with no positive weight, which could never progress', async () => {
    const emptyProfileId = findOneOrThrow(
      await db.drizzle.db
        .insert(promoWeightProfile)
        .values({ name: `empty-profile-${randomUUID()}` })
        .returning(),
      new Error('seed profile: query returned no row'),
    ).id;

    await expect(
      grant(
        args({
          terms: { wageringMultiplier: '35', expiryDays: 7, weightProfileId: emptyProfileId },
        }),
      ),
    ).rejects.toThrow(/no positive weight/i);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a grant on a weight profile whose only rows are zero, which could never progress', async () => {
    await db.drizzle.db.insert(promoWeight).values({
      profileId: weightProfileId,
      scope: 'product',
      scopeRef: 'casino',
      contributionPercent: '0',
    });
    await db.drizzle.db
      .update(promoWeight)
      .set({ contributionPercent: '0' })
      .where(eq(promoWeight.profileId, weightProfileId));

    await expect(grant(args())).rejects.toThrow(/no positive weight/i);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a grant whose weight profile does not exist', async () => {
    await expect(
      grant(
        args({ terms: { wageringMultiplier: '35', expiryDays: 7, weightProfileId: randomUUID() } }),
      ),
    ).rejects.toThrow(/WagerWeightProfile/i);
  });

  it('expires the grant `expiryDays` after it was created', async () => {
    await grant(args({ terms: termsWith('1', 7) }));

    const [row] = await rows();
    const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 5);
  });

  it('a replayed deposit returns the first grant and creates no second row', async () => {
    const a = args();

    const first = await grant(a);
    const second = await grant(a);

    expect(second).toEqual({ ...first, created: false });
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a replay that asks for different money under the same reference', async () => {
    const a = args({ amount: '100' });
    await grant(a);

    await expect(grant({ ...a, amount: '500' })).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });

  it('concurrent duplicates settle to one grant, the index is the guard', async () => {
    const a = args();

    const outcomes = await Promise.all([grant(a), grant(a), grant(a)]);

    expect(await rows()).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok && o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => (o.ok ? o.grantId : null))).size).toBe(1);
  });

  it('the same source ref under a different source is a different grant', async () => {
    const sourceRef = randomUUID();
    const userId = randomUUID();

    await grant(args({ userId, sourceRef, source: 'deposit' }));
    await grant(
      args({ userId, sourceRef, source: 'manual', actor: { type: 'admin', id: randomUUID() } }),
    );

    expect(await rows()).toHaveLength(2);
  });

  it('the same source ref for a different player is a different grant', async () => {
    const sourceRef = randomUUID();

    await grant(args({ sourceRef }));
    await grant(args({ sourceRef }));

    expect(await rows()).toHaveLength(2);
  });

  it('writes one audit row per grant, on the same transaction', async () => {
    const a = args();
    await grant(a);
    await grant(a);

    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'promo.bonus.granted', actorType: 'system' }),
    );
  });

  it('records the admin behind a manual grant, so a hand-issued bonus is attributable', async () => {
    const adminId = randomUUID();
    await grant(args({ source: 'manual', actor: { type: 'admin', id: adminId } }));

    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorType: 'admin', actorId: adminId }),
    );
  });

  it('rejects a zero or negative amount before it reaches the ledger', async () => {
    await expect(grant(args({ amount: '0' }))).rejects.toThrow();
    await expect(grant(args({ amount: '-1' }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects an amount that is not a decimal string', async () => {
    await expect(grant(args({ amount: 'NaN' }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a multiplier of zero, which would convert the moment it was granted', async () => {
    await expect(grant(args({ terms: termsWith('0') }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a negative multiplier', async () => {
    await expect(grant(args({ terms: termsWith('-1') }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a multiplier past the sane ceiling, which is a fat finger not an offer', async () => {
    await expect(grant(args({ terms: termsWith('100000') }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects an expiry that is not a positive whole number of days', async () => {
    await expect(grant(args({ terms: termsWith('35', 0) }))).rejects.toThrow();
    await expect(grant(args({ terms: termsWith('35', 1.5) }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects an expiry past the sane ceiling', async () => {
    await expect(grant(args({ terms: termsWith('35', 3651) }))).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a manual grant with no admin behind it', async () => {
    await expect(grant(args({ source: 'manual', actor: { type: 'system' } }))).rejects.toThrow(
      /admin/,
    );
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a non-manual grant that names an admin actor, which would misattribute it in the audit trail', async () => {
    await expect(
      grant(args({ source: 'deposit', actor: { type: 'admin', id: randomUUID() } })),
    ).rejects.toThrow(/admin/);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects an amount whose requirement would overflow the column', async () => {
    await expect(
      grant(args({ amount: '99999999999999999999', terms: termsWith('2') })),
    ).rejects.toThrow(/too large/);
    expect(await rows()).toHaveLength(0);
  });

  it('a replay still returns the first grant after its weight profile was deleted', async () => {
    const a = args();
    const first = await grant(a);
    await db.drizzle.db
      .delete(promoWeightProfile)
      .where(eq(promoWeightProfile.id, weightProfileId));

    expect(await grant(a)).toEqual({ ...first, created: false });
    expect(await rows()).toHaveLength(1);
  });

  it('the database refuses a forfeit without a reason, and a reason without a forfeit', async () => {
    await grant(args());
    const [row] = await rows();
    const set = (values: Partial<typeof promoGrant.$inferInsert>) =>
      db.drizzle.db.update(promoGrant).set(values).where(eq(promoGrant.id, row!.id));

    await expect(set({ status: 'forfeited' })).rejects.toThrow();
    await expect(set({ forfeitReason: 'admin' })).rejects.toThrow();
    await expect(set({ status: 'forfeited', forfeitReason: 'admin' })).resolves.toBeDefined();
  });

  it('rolls the audit write back with the grant when the transaction fails', async () => {
    const a = args();
    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await service.grant(tx, a);
        throw new Error('caller failed after the grant');
      }),
    ).rejects.toThrow('caller failed after the grant');

    expect(await rows()).toHaveLength(0);
  });
});

describe('the grant ledger', () => {
  it('opens with one entry carrying the granted amount', async () => {
    const outcome = await grant(args({ amount: '250', currency: 'USD' }));
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grantId: outcome.grantId,
      currency: 'USD',
      type: 'grant',
      bonusAmount: '250.000000000000000000',
      realAmount: '0.000000000000000000',
      wageringDelta: '0.000000000000000000',
      balanceAfter: '250.000000000000000000',
      externalRoundId: null,
      walletTransactionId: null,
    });
  });

  it('adds no second entry when a grant is replayed', async () => {
    const a = args();
    await grant(a);
    await grant(a);

    expect(await entries()).toHaveLength(1);
  });

  it('adds no entry when concurrent replays race', async () => {
    const a = args();
    await Promise.all([grant(a), grant(a), grant(a)]);

    expect(await entries()).toHaveLength(1);
  });

  it('sums to exactly the bonus balance it explains', async () => {
    const outcome = await grant(args({ amount: '77.5' }));
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }

    const [row] = await rows();
    expect(await ledgerSum(outcome.grantId)).toBe(row?.bonusBalance);
  });

  it('keeps one ledger per grant when a player holds several', async () => {
    const userId = randomUUID();
    const one = await grant(args({ userId, amount: '10' }));
    const two = await grant(args({ userId, amount: '20' }));
    if (!one.ok || !two.ok) {
      throw new Error('grant was refused');
    }

    expect(await ledgerSum(one.grantId)).toBe('10.000000000000000000');
    expect(await ledgerSum(two.grantId)).toBe('20.000000000000000000');
  });

  it('refuses to let a grant be deleted out from under its history', async () => {
    const outcome = await grant(args());
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }

    await expect(
      db.drizzle.db.delete(promoGrant).where(eq(promoGrant.id, outcome.grantId)),
    ).rejects.toThrow();
    expect(await entries()).toHaveLength(1);
  });

  it('refuses to update a ledger row directly, the FK guard alone is not the boundary', async () => {
    const outcome = await grant(args());
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }

    await expect(
      db.drizzle.db
        .update(promoGrantEntry)
        .set({ bonusAmount: '999' })
        .where(eq(promoGrantEntry.grantId, outcome.grantId)),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }),
      }),
    );
  });

  it('refuses to delete a ledger row directly', async () => {
    const outcome = await grant(args());
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }

    await expect(
      db.drizzle.db.delete(promoGrantEntry).where(eq(promoGrantEntry.grantId, outcome.grantId)),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }),
      }),
    );
  });

  it('rolls back with the grant when the caller fails', async () => {
    const a = args();
    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await service.grant(tx, a);
        throw new Error('caller failed after the grant');
      }),
    ).rejects.toThrow('caller failed after the grant');

    expect(await entries()).toHaveLength(0);
  });

  it('refuses a bonus_balance drift from the ledger, the append-only trigger alone is not the boundary', async () => {
    const outcome = await grant(args());
    if (!outcome.ok) {
      throw new Error('grant was refused');
    }

    // No corresponding entry backs this: the sum of this grant's entries still equals its
    // original credit, so a bare balance write is exactly the drift the deferred constraint
    // trigger exists to catch.
    await expect(
      db.drizzle.db.transaction((tx) =>
        tx.update(promoGrant).set({ bonusBalance: '0' }).where(eq(promoGrant.id, outcome.grantId)),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringMatching(/ledger mismatch/) }),
      }),
    );
  });
});
