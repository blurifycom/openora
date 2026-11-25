import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  DepositRefusedError,
  LedgerProjectionStaleError,
  RgLimitExceededError,
  limitSlotKey,
  type PaymentAdapter,
  type PlayEligibilityPort,
  type PlayEligibilitySnapshot,
  type RgLimitsPort,
  type RgLimitsSnapshot,
} from '@openora/core/contracts';
import { setErrorReporter, withAdvisoryXactLocks } from '@openora/core/server';
import { createTestDb, waitForRowLockWaiter, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeExchangeRateReader,
  makeAuditWriter,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  ledgerPlayEligibility,
  ledgerProjectionHeartbeat,
  ledgerUserLimit,
  ledgerUserLimitVersion,
  wallet,
  walletTransaction,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';
import { LedgerPlayEligibilityService } from '../service/ledger-play-eligibility.service.js';
import { LedgerRgLimitsService } from '../service/ledger-rg-limits.service.js';

let db: TestDb;

const REFUSED = {
  allowed: false as const,
  limitType: 'deposit' as const,
  period: 'daily' as const,
  limit: '100',
  used: '90',
  currency: 'USD',
};

function makeService(rgLimits?: RgLimitsPort, playEligibility?: PlayEligibilityPort) {
  const payment = mock<PaymentAdapter>({
    processDeposit: vi.fn(async () => ({ externalId: `psp-${randomUUID()}`, status: 'completed' })),
  });
  const svc = new WalletService({
    ...makeWithdrawalPorts(),
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment,
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    rates: makeExchangeRateReader(),
    ...(rgLimits ? { rgLimits } : {}),
    ...(playEligibility ? { playEligibility } : {}),
  });
  return { svc, payment };
}

const refusingGate = () =>
  mock<RgLimitsPort>({
    referenceCurrency: vi.fn(async () => null),
    checkDeposit: vi.fn(async () => REFUSED),
    checkWager: vi.fn(),
  });

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService deposit RG limit gate (real PG)', () => {
  it('refuses a deposit over the limit BEFORE calling the PSP', async () => {
    const { svc, payment } = makeService(refusingGate());

    await expect(
      svc.deposit({ userId: randomUUID(), amount: '30', currency: 'USD' }),
    ).rejects.toBeInstanceOf(RgLimitExceededError);
    expect(payment.processDeposit).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(0);
  });

  it('carries the whole reason as typed data so the client can translate it', async () => {
    const { svc } = makeService(refusingGate());

    await expect(
      svc.deposit({ userId: randomUUID(), amount: '30', currency: 'USD' }),
    ).rejects.toMatchObject({
      data: {
        limitType: 'deposit',
        period: 'daily',
        limit: '100',
        used: '90',
        currency: 'USD',
      },
    });
  });

  it('lets a deposit within the limit through', async () => {
    const { svc, payment } = makeService(
      mock<RgLimitsPort>({
        referenceCurrency: vi.fn(async () => null),
        checkDeposit: vi.fn(async () => ({ allowed: true })),
        checkWager: vi.fn(),
      }),
    );

    await expect(
      svc.deposit({ userId: randomUUID(), amount: '30', currency: 'USD' }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(payment.processDeposit).toHaveBeenCalled();
  });

  it('lets a replay of a completed deposit through even once the limit is used up', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    let used = 0;
    const gate = mock<RgLimitsPort>({
      referenceCurrency: vi.fn(async () => null),
      checkWager: vi.fn(),
      checkDeposit: vi.fn(async (_u: string, amount: string) => {
        if (used + Number(amount) > 100) {
          return { ...REFUSED, used: String(used) };
        }
        used += Number(amount);
        return { allowed: true as const };
      }),
    });
    const { svc, payment } = makeService(gate);
    const first = await svc.deposit({ userId, amount: '100', currency: 'USD', idempotencyKey });

    const replay = await svc.deposit({ userId, amount: '100', currency: 'USD', idempotencyKey });

    expect(replay.transactionId).toBe(first.transactionId);
    expect(payment.processDeposit).toHaveBeenCalledTimes(1);
    expect(gate.checkDeposit).toHaveBeenCalledTimes(1);
  });

  it('passes deposits through untouched when no gate is bound', async () => {
    const { svc } = makeService();

    await expect(
      svc.deposit({ userId: randomUUID(), amount: '30', currency: 'USD' }),
    ).resolves.toMatchObject({ status: 'completed' });
  });
});

const DAY = 24 * 60 * 60 * 1000;

const eligible = (userId: string, version = 0): PlayEligibilitySnapshot => ({
  userId,
  rgBlocked: false,
  rgBlockedUntil: null,
  isActive: true,
  banned: false,
  banExpires: null,
  status: 'active',
  version,
});

const dailyDepositLimit = (userId: string, amount: string): RgLimitsSnapshot => ({
  userId,
  version: 1,
  limits: [
    {
      limitId: randomUUID(),
      type: 'deposit',
      period: 'daily',
      amount,
      currency: 'USD',
      changedAt: new Date().toISOString(),
    },
  ],
});

describe('the ledger projections (real PG)', () => {
  beforeEach(async () => {
    await db.drizzle.db.execute(
      sql`TRUNCATE ${ledgerPlayEligibility}, ${ledgerProjectionHeartbeat}, ${ledgerUserLimit}, ${ledgerUserLimitVersion}`,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    setErrorReporter(undefined);
  });

  it('holds a remote limit write behind a stake that holds the limit slot', async () => {
    const userId = randomUUID();
    const ledger = new LedgerRgLimitsService(db.drizzle, undefined);

    await db.drizzle.db.transaction((stake) =>
      withAdvisoryXactLocks(stake, [limitSlotKey(userId, 'deposit', 'daily')], async () => {
        await expect(
          db.drizzle.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '200ms'`);
            await ledger.writeFromRemote(dailyDepositLimit(userId, '15'), tx);
          }),
        ).rejects.toMatchObject({ cause: { code: '55P03' } });
      }),
    );
  });

  it('judges a cooling-off end by the database clock, not the replica clock', async () => {
    const userId = randomUUID();
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    await projection.reconcile([
      {
        ...eligible(userId),
        rgBlocked: true,
        rgBlockedUntil: new Date(Date.now() + DAY).toISOString(),
      },
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * DAY);

    await expect(projection.checkPlay(userId)).resolves.toBe('cooling_off');
    await expect(projection.isRestricted(userId)).resolves.toBe(true);
  });

  it('opens a limit window by the database clock, not the replica clock', async () => {
    const userId = randomUUID();
    const limits = new LedgerRgLimitsService(db.drizzle, undefined);
    await db.drizzle.db.transaction((tx) => limits.write(dailyDepositLimit(userId, '100'), tx));
    const { svc, payment } = makeService(limits);
    await svc.deposit({ userId, amount: '90', currency: 'USD' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * DAY);

    await expect(svc.deposit({ userId, amount: '30', currency: 'USD' })).rejects.toBeInstanceOf(
      RgLimitExceededError,
    );
    expect(payment.processDeposit).toHaveBeenCalledTimes(1);
  });

  it('alerts once the heartbeat is past the alert age, before it refuses', async () => {
    const userId = randomUUID();
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    const projection = new LedgerPlayEligibilityService(db.drizzle, {
      remoteWriter: () => true,
      staleMs: 60_000,
      alertMs: 30_000,
    });
    await projection.reconcile([eligible(userId)]);
    await db.drizzle.db
      .insert(ledgerProjectionHeartbeat)
      .values({ projection: 'play_eligibility', beatAt: sql`now() - interval '10 seconds'` });
    await projection.checkPlay(userId);
    expect(reported).toHaveLength(0);

    await db.drizzle.db
      .update(ledgerProjectionHeartbeat)
      .set({ beatAt: sql`now() - interval '40 seconds'` });

    await expect(projection.checkPlay(userId)).resolves.toBeNull();
    expect(reported).toHaveLength(1);

    await db.drizzle.db
      .update(ledgerProjectionHeartbeat)
      .set({ beatAt: sql`now() - interval '70 seconds'` });
    await expect(projection.checkPlay(userId)).rejects.toBeInstanceOf(LedgerProjectionStaleError);
  });

  it('refuses a deposit against a block that commits while the deposit reads the projection', async () => {
    const userId = randomUUID();
    const projection = new LedgerPlayEligibilityService(db.drizzle);
    await projection.reconcile([eligible(userId)]);
    const { svc, payment } = makeService(undefined, projection);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = () => {};
    const blocking = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const block = db.drizzle.db.transaction(async (tx) => {
      await tx
        .update(ledgerPlayEligibility)
        .set({ rgBlocked: true, version: 1 })
        .where(eq(ledgerPlayEligibility.userId, userId));
      blocked();
      await released;
    });
    await blocking;

    const deposit = svc.deposit({ userId, amount: '30', currency: 'USD' });
    const settled = deposit.catch((err: unknown) => err);
    await waitForRowLockWaiter(db).finally(release);
    await block;

    expect(await settled).toBeInstanceOf(DepositRefusedError);
    expect(payment.processDeposit).not.toHaveBeenCalled();
  });
});
