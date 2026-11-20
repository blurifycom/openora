import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow, moneyAdd, moneyCompare, moneySubtract } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  resolvePromoConfig,
  type BonusGrantArgs,
  type LockedFunds,
  type PlayEligibilityPort,
  type Uuid,
} from '@openora/core/contracts';
import { makeAuditWriter, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoGrant, promoGrantEntry, promoWeight, promoWeightProfile } from '../schema/index.js';
import { FundLockService } from '../service/fund-lock.service.js';
import { GrantLifecycleService } from '../service/grant-lifecycle.service.js';
import { GrantService } from '../service/grant.service.js';

let db: TestDb;
let grants: GrantService;
let locks: FundLockService;
let weightProfileId: Uuid;

const grantWithFunds = async (
  over: Partial<BonusGrantArgs> & { userId: string },
  funds: { unlinked: string; linked: string },
) => {
  const outcome = await db.drizzle.db.transaction((tx) =>
    grants.grant(tx, {
      currency: 'USD',
      amount: '10',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '5', expiryDays: 30, weightProfileId },
      ...over,
    }),
  );
  if (!outcome.ok) {
    throw new Error('grant was refused');
  }
  await db.drizzle.db
    .update(promoGrant)
    .set({ unlinkedCash: funds.unlinked, linkedCash: funds.linked })
    .where(eq(promoGrant.id, outcome.grantId));
};

const withdrawal = (userId: string, amount: string, balance: string) =>
  db.drizzle.db.transaction((tx) =>
    locks.onOutflow(tx, {
      userId,
      currency: 'USD',
      amount,
      balanceAfter: moneySubtract(balance, amount),
      outflow: 'withdrawal',
      actor: { id: userId, isAdmin: false },
      note: 'withdrawal',
    }),
  );

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

beforeAll(async () => {
  db = await createTestDb([migrate]);
  const audit = makeAuditWriter();
  grants = new GrantService(audit);
  const unrestricted: PlayEligibilityPort = { isRestricted: async () => false };
  const lifecycle = new GrantLifecycleService(db.drizzle, audit, makeEventBus(), unrestricted);
  locks = new FundLockService(lifecycle, {
    ...resolvePromoConfig(undefined).bonus,
    withdrawalWhileActive: 'block',
  });
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await wipeLedger();
  await db.drizzle.db.delete(promoGrant);
  await db.drizzle.db.delete(promoWeight);
  await db.drizzle.db.delete(promoWeightProfile);
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

describe('the display read and the withdrawal check', () => {
  it('report the same locked and free money, and the refusal starts one cent past free', async () => {
    const userId = randomUUID();
    await grantWithFunds({ userId }, { unlinked: '30', linked: '70' });
    await grantWithFunds({ userId, source: 'rank' }, { unlinked: '0', linked: '50' });
    await grantWithFunds({ userId, currency: 'EUR' }, { unlinked: '0', linked: '40' });

    const [usd, eur] = await locks.readLockedFunds(db.drizzle.db, {
      userId,
      balances: [
        { currency: 'USD', realBalance: '150' },
        { currency: 'EUR', realBalance: '10' },
      ],
    });
    const read = usd as LockedFunds;
    expect(moneyCompare(read.locked, '100')).toBe(0);
    expect(moneyCompare(read.free, '50')).toBe(0);
    expect(moneyCompare(eur!.locked, '10')).toBe(0);
    expect(moneyCompare(eur!.free, '0')).toBe(0);

    await expect(withdrawal(userId, read.free, '150')).resolves.toBeUndefined();
    const refused = await withdrawal(userId, moneyAdd(read.free, '0.01'), '150').catch(
      (err: unknown) => err,
    );
    expect(refused).toMatchObject({
      name: 'BonusFundsLockedError',
      data: { reason: 'bonus_funds_locked', outflow: 'withdrawal' },
    });
    const { data } = refused as { data: LockedFunds };
    expect(moneyCompare(data.locked, read.locked)).toBe(0);
    expect(moneyCompare(data.free, read.free)).toBe(0);
  });

  it('reads nothing locked for a player with no live grant', async () => {
    const [funds] = await locks.readLockedFunds(db.drizzle.db, {
      userId: randomUUID(),
      balances: [{ currency: 'USD', realBalance: '25' }],
    });
    expect(moneyCompare(funds!.locked, '0')).toBe(0);
    expect(moneyCompare(funds!.free, '25')).toBe(0);
  });
});
