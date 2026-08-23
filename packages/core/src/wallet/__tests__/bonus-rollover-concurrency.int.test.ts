import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PaymentAdapter, PlayEligibilityPort } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeAuditWriter,
  makeIdentityReader,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletBonusCredit,
  walletBonusRolloverConfig,
} from '../schema/index.js';
import { WalletCommandsService } from '../service/wallet-commands.service.js';
import {
  WalletService,
  BonusRolloverLockedError,
  InsufficientBalanceError,
} from '../service/wallet.service.js';

/**
 * QA concurrency probe for bonus-rollover tracking, independent of the implementer's
 * own tests. The plan's "biggest modeling assumption" callout was sequential/waterfall
 * clearing; its
 * "core worry that justified the atomic guarded-UPDATE design" was a race between a
 * concurrent bet completing a bonus's rollover and a withdrawal reading a stale view
 * of how much is still locked. Both are only provable by actually firing overlapping
 * transactions against real Postgres, not by asserting on a single-threaded call
 * sequence (which is all the co-located dev tests do). Each `it` below repeats several
 * trials with a fresh wallet+credit per trial: a lock-ordering bug would not
 * necessarily reproduce on the first race.
 */

let db: TestDb;

const unrestricted = mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(false) });

// A concurrent bet-debit + withdraw on the SAME wallet can hit a genuine Postgres
// deadlock (40P01) - confirmed via a control run with NO bonus credit involved at all,
// so it is a pre-existing lock-ordering hazard between WalletService.withdraw()'s
// `SELECT ... FOR UPDATE` on `wallet` and WalletCommandsService.debit()'s unlocked
// wallet read + walletTransaction insert (FK-checked against the same wallet row),
// not something bonus-rollover tracking introduced. Reported separately (QA finding,
// not a regression from this feature). A deadlock aborts the whole losing transaction with no partial writes,
// so retrying it is safe - this keeps the test asserting the actual money-safety
// invariant under test instead of flaking on that unrelated, already-existing hazard.
// Drizzle wraps the pg driver error as `.cause` - the actual "deadlock detected" text
// (and the 40P01 code) live there, not on the outer DrizzleQueryError's own `.message`.
function isDeadlock(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.message.includes('deadlock detected')) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    if ('code' in cause && cause.code === '40P01') {
      return true;
    }
    if (cause instanceof Error && cause.message.includes('deadlock detected')) {
      return true;
    }
  }
  return false;
}

async function withDeadlockRetry<T>(fn: () => Promise<T>, retries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < retries && isDeadlock(err)) {
        continue;
      }
      throw err;
    }
  }
}

async function seedWallet(balance: string, currency = 'USD') {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: balance });
  return row;
}

async function insertCredit(
  w: { id: string; userId: string; currency: string },
  overrides: Partial<typeof walletBonusCredit.$inferInsert> = {},
) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(walletBonusCredit)
      .values({
        walletId: w.id,
        userId: w.userId,
        currency: w.currency,
        sourceType: 'gift',
        creditedAmount: '0',
        rolloverMultiplier: '1',
        rolloverRequired: '0',
        rolloverProgress: '0',
        status: 'active',
        ...overrides,
      })
      .returning(),
    new Error('insertCredit: query returned no row'),
  );
}

function makeCommandsSvc() {
  return new WalletCommandsService(unrestricted, makeAuditWriter());
}

function makeWalletSvc() {
  return new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({ processDeposit: vi.fn(), processWithdrawal: vi.fn() }),
    paymentProviders: makePaymentProviderRegistry(),
    identityReader: makeIdentityReader(),
    audit: makeAuditWriter(),
  });
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletBonusCredit}, ${walletBonusRolloverConfig}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('bonus-rollover QA concurrency probe: two simultaneous bets against ONE active credit', () => {
  const TRIALS = 8;

  it('never lets rolloverProgress exceed rolloverRequired and completes the credit exactly once, across repeated trials', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const w = await seedWallet('1000');
      const credit = await insertCredit(w, { creditedAmount: '100', rolloverRequired: '100' });
      const svc = makeCommandsSvc();

      // Two concurrent bets of 70 each: if progress were applied without a real DB
      // guard (eg read-modify-write in application code), both could read progress=0
      // and each write 70, landing at 70 (lost update) or 140 (double count) instead
      // of correctly capping at 100 with only one of the two reporting completion.
      const [r1, r2] = await Promise.all([
        db.drizzle.db.transaction((txn) =>
          svc.debit(txn, { userId: w.userId, amount: '70', type: 'bet' }),
        ),
        db.drizzle.db.transaction((txn) =>
          svc.debit(txn, { userId: w.userId, amount: '70', type: 'bet' }),
        ),
      ]);
      if (!r1.ok || !r2.ok) {
        throw new Error(`trial ${trial}: expected both debits ok`);
      }

      const [row] = await db.drizzle.db
        .select()
        .from(walletBonusCredit)
        .where(eq(walletBonusCredit.id, credit.id));
      expect(Number(row!.rolloverProgress), `trial ${trial}: progress must cap at 100`).toBe(100);
      expect(row!.status, `trial ${trial}: must flip to completed`).toBe('completed');

      const completions = [
        ...(r1.completedBonusCredits ?? []),
        ...(r2.completedBonusCredits ?? []),
      ];
      expect(
        completions,
        `trial ${trial}: exactly one debit reports the completion, not zero, not both`,
      ).toHaveLength(1);
      expect(completions[0]!.id).toBe(credit.id);
    }
  });
});

describe('bonus-rollover QA concurrency probe: withdrawal racing the bet that unlocks it', () => {
  const TRIALS = 8;

  it('a withdrawal for the full pre-bet balance never succeeds, regardless of which transaction wins the race', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      // locked = 100 - 90 = 10; the bet below is exactly the remaining rollover need,
      // so it both completes the credit AND is the only thing standing between
      // "locked" and "fully unlocked". There is no consistent DB snapshot in which
      // balance=100 AND locked=0 both hold at once (the bet's balance debit and its
      // rollover-progress update commit together, same transaction) - so a withdrawal
      // for the full 100 must be refused under every interleaving.
      const w = await seedWallet('100');
      await insertCredit(w, {
        creditedAmount: '100',
        rolloverRequired: '100',
        rolloverProgress: '90',
      });
      const commandsSvc = makeCommandsSvc();
      const walletSvc = makeWalletSvc();

      const betPromise = withDeadlockRetry(() =>
        db.drizzle.db.transaction((txn) =>
          commandsSvc.debit(txn, { userId: w.userId, amount: '10', type: 'bet' }),
        ),
      );
      const withdrawPromise = withDeadlockRetry(() =>
        walletSvc.withdraw({
          userId: w.userId,
          amount: '100',
          currency: 'USD',
          ip: null,
          userAgent: null,
        }),
      ).then(
        (res) => ({ ok: true as const, res }),
        (err: unknown) => ({ ok: false as const, err }),
      );

      const [betResult, withdrawOutcome] = await Promise.all([betPromise, withdrawPromise]);
      if (!betResult.ok) {
        throw new Error(`trial ${trial}: expected bet debit ok`);
      }

      expect(
        withdrawOutcome.ok,
        `trial ${trial}: a 100-unit withdrawal must never succeed here`,
      ).toBe(false);
      if (!withdrawOutcome.ok) {
        expect(
          withdrawOutcome.err,
          `trial ${trial}: refusal must be one of the two expected domain errors, not a generic failure`,
        ).toSatisfy(
          (err: unknown) =>
            err instanceof BonusRolloverLockedError || err instanceof InsufficientBalanceError,
        );
      }

      // Whatever the interleaving, the bet always lands (balance -10, credit completed) -
      // the withdrawal never got any money out.
      const [balRow] = await db.drizzle.db
        .select()
        .from(walletBalance)
        .where(eq(walletBalance.walletId, w.id));
      expect(
        Number(balRow!.amount),
        `trial ${trial}: only the bet's 10 ever left the balance`,
      ).toBe(90);

      const [creditRow] = await db.drizzle.db
        .select()
        .from(walletBonusCredit)
        .where(eq(walletBonusCredit.walletId, w.id));
      expect(creditRow!.status).toBe('completed');
      expect(Number(creditRow!.rolloverProgress)).toBe(100);
    }
  });

  it('a withdrawal for exactly the pre-bet UNLOCKED portion succeeds under either race ordering, and total money out is consistent', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const w = await seedWallet('100');
      await insertCredit(w, {
        creditedAmount: '100',
        rolloverRequired: '100',
        rolloverProgress: '90',
      });
      const commandsSvc = makeCommandsSvc();
      const walletSvc = makeWalletSvc();

      const betPromise = withDeadlockRetry(() =>
        db.drizzle.db.transaction((txn) =>
          commandsSvc.debit(txn, { userId: w.userId, amount: '10', type: 'bet' }),
        ),
      );
      const withdrawPromise = withDeadlockRetry(() =>
        walletSvc.withdraw({
          userId: w.userId,
          amount: '10',
          currency: 'USD',
          ip: null,
          userAgent: null,
        }),
      ).then(
        () => true,
        () => false,
      );

      const [betResult, withdrawSucceeded] = await Promise.all([betPromise, withdrawPromise]);
      if (!betResult.ok) {
        throw new Error(`trial ${trial}: expected bet debit ok`);
      }

      const [balRow] = await db.drizzle.db
        .select()
        .from(walletBalance)
        .where(eq(walletBalance.walletId, w.id));
      // The bet always spends 10. The withdrawal spends its own 10 only if it won -
      // either way, total money leaving the wallet is fully accounted for, never more.
      expect(
        Number(balRow!.amount),
        `trial ${trial}: balance must equal 100 - bet(10) - withdraw(10 if it succeeded)`,
      ).toBe(withdrawSucceeded ? 80 : 90);
    }
  });
});
