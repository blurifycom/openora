import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, seedPlayerWithUser, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import type {
  AuditWritePort,
  ExchangeRateReader,
  PlayEligibilityPort,
  RgExclusionReader,
  WalletCommands,
  WalletCreditArgs,
} from '@openora/core/contracts';
import { moneyScaleBy, type EventBus } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { migrate } from '../migrate.js';
import { migrate as identityMigrate } from '@openora/core/pam/migrate/identity';
import { migrate as profileMigrate } from '@openora/core/pam/migrate/profile';
import { promoPlayerRank, promoRakebackAccrual, promoRakebackClaim } from '../schema/index.js';
import {
  RakebackAccountBlockedError,
  RakebackBelowMinimumError,
  RakebackClaimConflictError,
  RakebackClaimRestrictedError,
  RakebackClaimService,
  RakebackNothingToClaimError,
} from '../service/rakeback-claim.service.js';
import {
  RakebackAccrualNotFoundError,
  RakebackAccrualNotVoidableError,
  RakebackAdminService,
} from '../service/rakeback-admin.service.js';

let db: TestDb;
const credit = vi.fn<WalletCommands['credit']>();
const isRestricted = vi.fn<PlayEligibilityPort['isRestricted']>();
const getExclusionState = vi.fn<RgExclusionReader['getExclusionState']>();
const recordInTransaction = vi.fn<AuditWritePort['recordInTransaction']>();
const claimAudit = vi.fn<AuditWritePort['recordInTransaction']>();
const emitInTransaction = vi.fn<EventBus['emitInTransaction']>();
const convert = vi.fn<ExchangeRateReader['convert']>(async (amount, from, to) =>
  from === 'EUR' && to === 'USDT' ? moneyScaleBy(amount, '2') : null,
);
const rates = mock<ExchangeRateReader>({ convert });

const claimsWith = (claimMinimum = '1') =>
  new RakebackClaimService({
    drizzle: db.drizzle,
    wallet: mock<WalletCommands>({ credit }),
    eligibility: mock<PlayEligibilityPort>({ isRestricted }),
    exclusions: mock<RgExclusionReader>({ getExclusionState }),
    rates,
    referenceCurrency: 'USDT',
    claimMinimum,
    audit: mock<AuditWritePort>({ recordInTransaction: claimAudit }),
    events: mock<EventBus>({ emitInTransaction }),
    logger: { info: vi.fn() },
  });

const admin = () =>
  new RakebackAdminService(
    db.drizzle,
    rates,
    mock<AuditWritePort>({ recordInTransaction }),
    'USDT',
  );

const newPlayer = async (status: 'active' | 'self_excluded' | 'suspended' | 'closed' = 'active') =>
  (await seedPlayerWithUser(db, { status })).account.id;

const accrue = async (userId: string, amount: string, currency = 'USDT') => {
  const [row] = await db.drizzle.db
    .insert(promoRakebackAccrual)
    .values({
      userId,
      currency,
      amount,
      stake: '100',
      basis: 'margin',
      rtp: '0.96',
      ratePercent: '5',
      boostPercent: '0',
      providerName: 'aggregator',
    })
    .returning();
  return row!;
};

const accrualsOf = (userId: string) =>
  db.drizzle.db.select().from(promoRakebackAccrual).where(eq(promoRakebackAccrual.userId, userId));

const creditedArgs = () => credit.mock.calls.map((call) => call[1] as WalletCreditArgs);

beforeAll(async () => {
  db = await createTestDb([migrate, identityMigrate, profileMigrate]);
});

afterAll(() => db.drop());

beforeEach(async () => {
  vi.clearAllMocks();
  credit.mockImplementation(async () => ({
    ok: true,
    moved: true,
    transactionId: randomUUID(),
    newBalance: '0',
  }));
  isRestricted.mockResolvedValue(false);
  getExclusionState.mockResolvedValue({ isSelfExcluded: false, isCoolingOff: false });
  await db.drizzle.db.delete(promoRakebackAccrual);
  await db.drizzle.db.delete(promoRakebackClaim);
  await db.drizzle.db.delete(promoPlayerRank);
});

describe('a player claiming their rakeback', () => {
  it('pays each currency as one cashback credit and marks every row claimed', async () => {
    const userId = await newPlayer();
    await accrue(userId, '0.6');
    await accrue(userId, '0.4');
    await accrue(userId, '0.25', 'EUR');

    const result = await claimsWith().claim(userId, randomUUID());

    expect(result.paid.map(({ currency, amount }) => ({ currency, amount }))).toEqual([
      { currency: 'EUR', amount: '0.250000000000000000' },
      { currency: 'USDT', amount: '1.000000000000000000' },
    ]);
    expect(creditedArgs()).toEqual([
      expect.objectContaining({
        userId,
        currency: 'EUR',
        amount: '0.250000000000000000',
        type: 'cashback',
        providerRef: expect.objectContaining({
          providerName: 'rakeback-claim',
          providerRefId: `${result.claimId}:EUR`,
        }),
      }),
      expect.objectContaining({
        currency: 'USDT',
        amount: '1.000000000000000000',
        providerRef: expect.objectContaining({ providerRefId: `${result.claimId}:USDT` }),
      }),
    ]);
    const rows = await accrualsOf(userId);
    expect(rows.every((row) => row.status === 'claimed' && row.claimId === result.claimId)).toBe(
      true,
    );
  });

  it("audits the claim and writes each credit's balance event in its transaction", async () => {
    const userId = await newPlayer();
    await accrue(userId, '1');
    await accrue(userId, '0.25', 'EUR');

    const result = await claimsWith().claim(userId, randomUUID());

    const tx = credit.mock.calls[0]![0];
    expect(claimAudit).toHaveBeenCalledExactlyOnceWith(tx, {
      actorId: userId,
      actorType: 'player',
      action: 'promo.rakeback.claimed',
      resourceType: 'promo_rakeback_claim',
      resourceId: result.claimId,
      after: {
        userId,
        paid: [
          { currency: 'EUR', amount: '0.250000000000000000' },
          { currency: 'USDT', amount: '1.000000000000000000' },
        ],
      },
    });
    expect(emitInTransaction.mock.calls).toEqual(
      result.paid.map(({ currency, amount, transactionId }) => [
        tx,
        'wallet.balance.changed',
        expect.objectContaining({
          userId,
          currency,
          amount,
          transactionId,
          type: 'cashback',
          direction: 'credit',
        }),
      ]),
    );
  });

  it('rolls the whole claim back when the audit write fails', async () => {
    const userId = await newPlayer();
    await accrue(userId, '2');
    claimAudit.mockRejectedValueOnce(new Error('audit down'));

    await expect(claimsWith().claim(userId, randomUUID())).rejects.toThrow('audit down');

    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
    expect(await db.drizzle.db.select().from(promoRakebackClaim)).toEqual([]);
  });

  it('claims a backlog larger than one query can bind as separate parameters', async () => {
    const userId = await newPlayer();
    await db.drizzle.db.execute(sql`
      insert into promo_rakeback_accrual
        (user_id, currency, amount, stake, basis, rate_percent, boost_percent)
      select ${userId}, 'USDT', 0.001, 1, 'margin', 5, 0 from generate_series(1, 70000)`);

    const result = await claimsWith().claim(userId, randomUUID());

    expect(result.paid).toEqual([
      expect.objectContaining({ currency: 'USDT', amount: '70.000000000000000000' }),
    ]);
  });

  it('returns the first result for a retry with the same key and pays nothing more', async () => {
    const userId = await newPlayer();
    await accrue(userId, '2');
    const key = randomUUID();
    const first = await claimsWith().claim(userId, key);
    await accrue(userId, '3');

    const retry = await claimsWith().claim(userId, key);

    expect(credit).toHaveBeenCalledTimes(1);
    expect(retry).toEqual({
      userId,
      claimId: first.claimId,
      paid: [{ currency: 'USDT', amount: '2.000000000000000000', transactionId: null }],
    });
    expect((await accrualsOf(userId)).filter((row) => row.status === 'accrued')).toHaveLength(1);
  });

  it('pays each row once when two claims with different keys race', async () => {
    const userId = await newPlayer();
    await accrue(userId, '2');
    await accrue(userId, '3');

    const results = await Promise.allSettled([
      claimsWith().claim(userId, randomUUID()),
      claimsWith().claim(userId, randomUUID()),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toSatisfy(
      (err: unknown) =>
        err instanceof RakebackClaimConflictError || err instanceof RakebackNothingToClaimError,
    );
    const rows = await accrualsOf(userId);
    expect(new Set(rows.map((row) => row.claimId)).size).toBe(1);
    expect(await db.drizzle.db.select().from(promoRakebackClaim)).toHaveLength(1);
  });

  it('pays once when the same key is sent twice at the same moment', async () => {
    const userId = await newPlayer();
    await accrue(userId, '2');
    const key = randomUUID();

    const [a, b] = await Promise.all([
      claimsWith().claim(userId, key),
      claimsWith().claim(userId, key),
    ]);

    expect(a.claimId).toBe(b.claimId);
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it('checks the minimum on the total priced into the reference currency', async () => {
    const userId = await newPlayer();
    await accrue(userId, '0.4');
    await accrue(userId, '0.3', 'EUR');

    await expect(claimsWith('1').claim(userId, randomUUID())).resolves.toMatchObject({
      paid: [
        expect.objectContaining({ currency: 'EUR' }),
        expect.objectContaining({ currency: 'USDT' }),
      ],
    });
  });

  it('refuses a claim below the minimum and pays nothing', async () => {
    const userId = await newPlayer();
    await accrue(userId, '0.99');

    await expect(claimsWith('1').claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackBelowMinimumError,
    );
    expect(credit).not.toHaveBeenCalled();
    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
    expect(await db.drizzle.db.select().from(promoRakebackClaim)).toEqual([]);
  });

  it('counts a currency with no rate as nothing toward the minimum, yet still pays it', async () => {
    const userId = await newPlayer();
    await accrue(userId, '5', 'BTC');

    await expect(claimsWith('1').claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackBelowMinimumError,
    );

    await accrue(userId, '1');
    const result = await claimsWith('1').claim(userId, randomUUID());
    expect(result.paid.map((row) => row.currency)).toEqual(['BTC', 'USDT']);
  });

  it('refuses when there is nothing to claim', async () => {
    const userId = await newPlayer();

    await expect(claimsWith('0').claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackNothingToClaimError,
    );
  });

  it('refuses a player under an active responsible-gambling restriction', async () => {
    const userId = await newPlayer();
    await accrue(userId, '5');
    isRestricted.mockResolvedValue(true);

    await expect(claimsWith().claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackClaimRestrictedError,
    );
    expect(credit).not.toHaveBeenCalled();
  });

  it('refuses a self-excluded player', async () => {
    const userId = await newPlayer('self_excluded');
    await accrue(userId, '5');

    await expect(claimsWith().claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackClaimRestrictedError,
    );
    expect(credit).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'closed'] as const)('refuses a %s account', async (status) => {
    const userId = await newPlayer(status);
    await accrue(userId, '5');

    await expect(claimsWith().claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackAccountBlockedError,
    );
    expect(credit).not.toHaveBeenCalled();
  });

  it('rolls the whole claim back when the wallet refuses a credit', async () => {
    const userId = await newPlayer();
    await accrue(userId, '5');
    credit.mockResolvedValue({ ok: false, reason: 'wallet not found' });

    await expect(claimsWith().claim(userId, randomUUID())).rejects.toThrow(/wallet not found/);
    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
    expect(await db.drizzle.db.select().from(promoRakebackClaim)).toEqual([]);
  });

  it('never claims a reversed or voided row', async () => {
    const userId = await newPlayer();
    const reversed = await accrue(userId, '5');
    await db.drizzle.db
      .update(promoRakebackAccrual)
      .set({ status: 'reversed' })
      .where(eq(promoRakebackAccrual.id, reversed.id));
    await accrue(userId, '2');

    const result = await claimsWith().claim(userId, randomUUID());

    expect(result.paid).toEqual([
      expect.objectContaining({ currency: 'USDT', amount: '2.000000000000000000' }),
    ]);
  });
});

describe('the rakeback summary a player reads', () => {
  it('shows the unclaimed total, the minimum, and what blocks a claim', async () => {
    const userId = await newPlayer();
    await accrue(userId, '0.25');
    await accrue(userId, '0.25', 'EUR');

    const summary = await claimsWith('1').summary(userId);

    expect(summary).toEqual({
      unclaimed: [
        {
          currency: 'EUR',
          amount: '0.250000000000000000',
          referenceAmount: '0.500000000000000000',
        },
        {
          currency: 'USDT',
          amount: '0.250000000000000000',
          referenceAmount: '0.250000000000000000',
        },
      ],
      referenceCurrency: 'USDT',
      referenceTotal: '0.750000000000000000',
      claimMinimum: '1',
      claimBlockedBy: 'below_minimum',
      lifetimeClaimed: [],
    });
  });

  it('reports a restriction ahead of anything else', async () => {
    const userId = await newPlayer();
    await accrue(userId, '5');
    isRestricted.mockResolvedValue(true);

    expect((await claimsWith().summary(userId)).claimBlockedBy).toBe('restricted');
  });

  it('shows no blocker once a claim is possible, and the lifetime total after it', async () => {
    const userId = await newPlayer();
    await accrue(userId, '5');
    expect((await claimsWith().summary(userId)).claimBlockedBy).toBeNull();

    await claimsWith().claim(userId, randomUUID());

    const after = await claimsWith().summary(userId);
    expect(after.claimBlockedBy).toBe('nothing_to_claim');
    expect(after.lifetimeClaimed).toEqual([{ currency: 'USDT', amount: '5.000000000000000000' }]);
  });
});

describe('rakeback auto-payout', () => {
  it('pays a self-excluded player below the minimum, once', async () => {
    const userId = await newPlayer('self_excluded');
    await accrue(userId, '0.2');

    const first = await claimsWith('10').autoPay(userId);
    const second = await claimsWith('10').autoPay(userId);

    expect(first?.paid).toEqual([
      expect.objectContaining({ currency: 'USDT', amount: '0.200000000000000000' }),
    ]);
    expect(second).toBeNull();
    expect(credit).toHaveBeenCalledTimes(1);
    expect(isRestricted).not.toHaveBeenCalled();
    const [claim] = await db.drizzle.db.select().from(promoRakebackClaim);
    expect(claim?.outcome).toBe('auto_paid');
    expect(claimAudit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        actorId: null,
        actorType: 'system',
        action: 'promo.rakeback.auto_paid',
        resourceId: claim?.id,
      }),
    );
  });

  it('pays once when two auto-payouts for the same player race', async () => {
    const userId = await newPlayer('closed');
    await accrue(userId, '3');

    await Promise.allSettled([claimsWith().autoPay(userId), claimsWith().autoPay(userId)]);

    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'claimed' })]);
    expect(await db.drizzle.db.select().from(promoRakebackClaim)).toHaveLength(1);
  });

  it('finds closed and self-excluded players holding unclaimed rakeback, but not a cooling-off one', async () => {
    const active = await newPlayer();
    const closed = await newPlayer('closed');
    const excluded = await newPlayer('self_excluded');
    const blockedExcluded = await newPlayer();
    const coolingOff = await newPlayer();
    const closedButPaid = await newPlayer('closed');
    for (const userId of [active, closed, excluded, blockedExcluded, coolingOff]) {
      await accrue(userId, '1');
    }
    await db.drizzle.db.update(user).set({ rgBlocked: true }).where(eq(user.id, blockedExcluded));
    await db.drizzle.db.update(user).set({ rgBlocked: true }).where(eq(user.id, coolingOff));
    getExclusionState.mockImplementation(async (userId) => ({
      isSelfExcluded: userId === blockedExcluded,
      isCoolingOff: userId === coolingOff,
    }));

    const due = await claimsWith().dueForAutoPayout();

    expect([...due].sort()).toEqual([closed, excluded, blockedExcluded].sort());
    expect(due).not.toContain(closedButPaid);
  });
});

describe('the claimable-rakeback reminder', () => {
  const rankFor = (userId: string) =>
    db.drizzle.db.insert(promoPlayerRank).values({ userId, currency: 'USDT' });

  it('tells a player at or over the minimum once a day', async () => {
    const userId = await newPlayer();
    await rankFor(userId);
    await accrue(userId, '2');
    const announce = vi.fn();
    const now = new Date('2026-10-01T10:00:00Z');

    await claimsWith('1').notifyClaimable(announce, now);
    await claimsWith('1').notifyClaimable(announce, new Date('2026-10-02T09:00:00Z'));
    await claimsWith('1').notifyClaimable(announce, new Date('2026-10-02T10:00:01Z'));

    expect(announce.mock.calls).toEqual([
      [{ userId, amount: '2.000000000000000000', currency: 'USDT' }],
      [{ userId, amount: '2.000000000000000000', currency: 'USDT' }],
    ]);
  });

  it('skips a player below the minimum, restricted, or on a blocked account', async () => {
    const below = await newPlayer();
    const restricted = await newPlayer();
    const suspended = await newPlayer('suspended');
    for (const userId of [below, restricted, suspended]) {
      await rankFor(userId);
    }
    await accrue(below, '0.5');
    await accrue(restricted, '5');
    await accrue(suspended, '5');
    isRestricted.mockImplementation(async (userId) => userId === restricted);
    const announce = vi.fn();

    const notified = await claimsWith('1').notifyClaimable(announce);

    expect(notified).toBe(0);
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('an admin voiding unclaimed rakeback', () => {
  const adminId = randomUUID();

  it('voids an accrued row with its reason and records an audit entry in the same transaction', async () => {
    const userId = await newPlayer();
    const row = await accrue(userId, '2');

    const voided = await admin().void(adminId, row.id, 'bonus abuse', { ip: '10.0.0.1' });

    expect(voided).toMatchObject({
      status: 'voided',
      voidedBy: adminId,
      voidReason: 'bonus abuse',
    });
    expect(recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rakeback.voided',
        resourceType: 'promo_rakeback_accrual',
        resourceId: row.id,
        before: { status: 'accrued' },
        after: expect.objectContaining({ status: 'voided', userId, reason: 'bonus abuse' }),
        ip: '10.0.0.1',
      }),
    );
    await expect(claimsWith('0').claim(userId, randomUUID())).rejects.toBeInstanceOf(
      RakebackNothingToClaimError,
    );
  });

  it('refuses to void a claimed row and records nothing', async () => {
    const userId = await newPlayer();
    const row = await accrue(userId, '2');
    await claimsWith().claim(userId, randomUUID());

    await expect(admin().void(adminId, row.id, 'too late')).rejects.toBeInstanceOf(
      RakebackAccrualNotVoidableError,
    );
    expect(recordInTransaction).not.toHaveBeenCalled();
  });

  it('reports an unknown accrual as not found', async () => {
    await expect(admin().void(adminId, randomUUID(), 'nothing')).rejects.toBeInstanceOf(
      RakebackAccrualNotFoundError,
    );
  });

  it('keeps the row unvoided when the audit write fails', async () => {
    const userId = await newPlayer();
    const row = await accrue(userId, '2');
    recordInTransaction.mockRejectedValueOnce(new Error('audit down'));

    await expect(admin().void(adminId, row.id, 'reason')).rejects.toThrow('audit down');
    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
  });
});

describe('the rakeback an admin reads', () => {
  it('lists accruals filtered by player and status, and prices the liability', async () => {
    const userId = await newPlayer();
    const other = await newPlayer();
    await accrue(userId, '1');
    await accrue(userId, '0.5', 'EUR');
    await accrue(other, '4');
    await claimsWith().claim(other, randomUUID());

    const listed = await admin().listAccruals({ userId, status: 'accrued', page: 1, limit: 10 });
    const liability = await admin().liability();
    const summary = await admin().playerSummary(other);

    expect(listed.total).toBe(2);
    expect(listed.items.every((item) => item.userId === userId)).toBe(true);
    expect(liability.referenceTotal).toBe('2.000000000000000000');
    expect(summary.unclaimed).toEqual([]);
    expect(summary.lifetimeClaimed).toEqual([{ currency: 'USDT', amount: '4.000000000000000000' }]);
  });
});
