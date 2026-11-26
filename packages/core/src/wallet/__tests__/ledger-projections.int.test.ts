import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  LedgerProjectionStaleError,
  limitSlotKey,
  type PlayEligibilitySnapshot,
  type RgLimitsSnapshot,
} from '@openora/core/contracts';
import { setErrorReporter, withAdvisoryXactLocks } from '@openora/core/server';
import {
  createTestDb,
  seedCompletedDeposit,
  waitForAdvisoryLockWaiter,
  waitForRowLockWaiter,
  type TestDb,
} from '../../testing/index.js';
import { migrate } from '../migrate.js';
import { ledgerPlayEligibility, ledgerProjectionHeartbeat, ledgerUserLimit } from '../schema/index.js';
import { LedgerPlayEligibilityService } from '../service/ledger-play-eligibility.service.js';
import { LedgerRgLimitsService } from '../service/ledger-rg-limits.service.js';

const DAY = 24 * 60 * 60 * 1000;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([migrate]);
}, 120_000);

afterAll(() => testDb.drop());

afterEach(() => {
  vi.useRealTimers();
  setErrorReporter(undefined);
});

const db = () => testDb.drizzle.db;

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

const setBeat = (projection: 'play_eligibility' | 'rg_limits', age: string) =>
  db()
    .insert(ledgerProjectionHeartbeat)
    .values({ projection, beatAt: sql`now() - ${age}::interval` })
    .onConflictDoUpdate({
      target: ledgerProjectionHeartbeat.projection,
      set: { beatAt: sql`now() - ${age}::interval` },
    });

const remoteFreshness = { remoteWriter: () => true, staleMs: 60_000, alertMs: 30_000 };

describe('the limits projection write path (real PG)', () => {
  it('holds a remote limit write behind a stake that holds the limit slot', async () => {
    const userId = randomUUID();
    const ledger = new LedgerRgLimitsService(testDb.drizzle, undefined);

    await db().transaction((stake) =>
      withAdvisoryXactLocks(stake, [limitSlotKey(userId, 'deposit', 'daily')], async () => {
        await expect(
          db().transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '200ms'`);
            await ledger.writeFromRemote(dailyDepositLimit(userId, '15'), tx);
          }),
        ).rejects.toMatchObject({ cause: { code: '55P03' } });
      }),
    );

    expect(await db().select().from(ledgerUserLimit).where(eq(ledgerUserLimit.userId, userId))).toEqual(
      [],
    );
  });

  it('holds a reconcile limit write behind a stake that holds the limit slot until the stake ends', async () => {
    const userId = randomUUID();
    const ledger = new LedgerRgLimitsService(testDb.drizzle, undefined);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stake = db().transaction((tx) =>
      withAdvisoryXactLocks(tx, [limitSlotKey(userId, 'deposit', 'daily')], () => released),
    );

    const reconciled = ledger.reconcile([dailyDepositLimit(userId, '15')]);
    await waitForAdvisoryLockWaiter(testDb).finally(release);
    await stake;

    await expect(reconciled).resolves.toBe(1);
    expect(await db().select().from(ledgerUserLimit).where(eq(ledgerUserLimit.userId, userId))).toHaveLength(
      1,
    );
  });

  it('opens a limit window by the database clock, not the replica clock', async () => {
    const userId = randomUUID();
    const limits = new LedgerRgLimitsService(testDb.drizzle, undefined);
    await db().transaction((tx) => limits.write(dailyDepositLimit(userId, '100'), tx));
    await seedCompletedDeposit(testDb, userId, '90');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * DAY);

    const decision = await db().transaction((tx) => limits.checkDeposit(tx, userId, '30', 'USD'));

    expect(decision).toMatchObject({ allowed: false, limitType: 'deposit', period: 'daily' });
  });
});

describe('the play eligibility projection read path (real PG)', () => {
  it('judges a cooling-off end by the database clock, not the replica clock', async () => {
    const userId = randomUUID();
    const projection = new LedgerPlayEligibilityService(testDb.drizzle);
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

  it('a read that waits on a block sees the block once it commits', async () => {
    const userId = randomUUID();
    const projection = new LedgerPlayEligibilityService(testDb.drizzle);
    await projection.reconcile([eligible(userId)]);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = () => {};
    const blocking = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const block = db().transaction(async (tx) => {
      await tx
        .update(ledgerPlayEligibility)
        .set({ rgBlocked: true, version: 1 })
        .where(eq(ledgerPlayEligibility.userId, userId));
      blocked();
      await released;
    });
    await blocking;

    const read = db().transaction((tx) => projection.checkPlay(userId, tx));
    const settled = read.catch((err: unknown) => err);
    await waitForRowLockWaiter(testDb).finally(release);
    await block;

    expect(await settled).toBe('self_excluded');
  });
});

describe('the projection heartbeat (real PG)', () => {
  it('never checks freshness when the writer is local, even with no heartbeat', async () => {
    const userId = randomUUID();
    const projection = new LedgerPlayEligibilityService(testDb.drizzle, {
      ...remoteFreshness,
      remoteWriter: () => false,
    });
    await projection.reconcile([eligible(userId)]);
    await db().delete(ledgerProjectionHeartbeat);

    await expect(projection.checkPlay(userId)).resolves.toBeNull();
  });

  it('refuses every read as stale when a remote writer has never beaten', async () => {
    const userId = randomUUID();
    const projection = new LedgerPlayEligibilityService(testDb.drizzle, remoteFreshness);
    await projection.reconcile([eligible(userId)]);
    await db().delete(ledgerProjectionHeartbeat);
    setErrorReporter(() => {});

    await expect(projection.checkPlay(userId)).rejects.toBeInstanceOf(LedgerProjectionStaleError);
    await expect(projection.statesOf([userId])).rejects.toBeInstanceOf(LedgerProjectionStaleError);
  });

  it('alerts once the heartbeat is past the alert age, before it refuses', async () => {
    const userId = randomUUID();
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    const projection = new LedgerPlayEligibilityService(testDb.drizzle, remoteFreshness);
    await projection.reconcile([eligible(userId)]);
    await setBeat('play_eligibility', '10 seconds');
    await projection.checkPlay(userId);
    expect(reported).toHaveLength(0);

    await setBeat('play_eligibility', '40 seconds');
    await expect(projection.checkPlay(userId)).resolves.toBeNull();
    expect(reported).toHaveLength(1);

    await setBeat('play_eligibility', '70 seconds');
    await expect(projection.checkPlay(userId)).rejects.toBeInstanceOf(LedgerProjectionStaleError);
  });

  it('alerts a late heartbeat once per alert interval, not once per check', async () => {
    const userId = randomUUID();
    const reported: unknown[] = [];
    setErrorReporter((error) => reported.push(error));
    const projection = new LedgerPlayEligibilityService(testDb.drizzle, remoteFreshness);
    await projection.reconcile([eligible(userId)]);
    await setBeat('play_eligibility', '40 seconds');
    vi.useFakeTimers({ toFake: ['Date'] });

    await projection.checkPlay(userId);
    await projection.checkPlay(userId);
    await projection.checkPlay(userId);
    expect(reported).toHaveLength(1);

    vi.setSystemTime(Date.now() + 30_000);
    await projection.checkPlay(userId);
    await projection.checkPlay(userId);
    expect(reported).toHaveLength(2);
  });

  it('gates the limit check on its own heartbeat and answers again once it beats', async () => {
    const userId = randomUUID();
    const limits = new LedgerRgLimitsService(testDb.drizzle, undefined, remoteFreshness);
    setErrorReporter(() => {});
    await setBeat('rg_limits', '70 seconds');

    await expect(
      db().transaction((tx) => limits.checkDeposit(tx, userId, '1', 'USD')),
    ).rejects.toMatchObject({ projection: 'rg_limits' });
    await limits.heartbeat();

    await expect(
      db().transaction((tx) => limits.checkDeposit(tx, userId, '1', 'USD')),
    ).resolves.toEqual({ allowed: true });
  });
});
