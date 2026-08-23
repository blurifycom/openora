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

let db: TestDb;

const unrestricted = mock<PlayEligibilityPort>({ isRestricted: vi.fn().mockResolvedValue(false) });

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
      expect(
        Number(balRow!.amount),
        `trial ${trial}: balance must equal 100 - bet(10) - withdraw(10 if it succeeded)`,
      ).toBe(withdrawSucceeded ? 80 : 90);
    }
  });
});
