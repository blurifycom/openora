import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { AdminPlayerSummary, AdminUserDirectory } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { user, session } from '@openora/core/pam/schema/identity';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { userLimit, rgFlag, rgExclusion } from '../schema/index.js';
import { RgMonitoringService } from '../service/rg-monitoring.service.js';

let db: TestDb;

const makeService = (directory?: AdminUserDirectory) =>
  new RgMonitoringService({ drizzle: db.drizzle, ...(directory ? { directory } : {}) });

async function seedDepositLimit(userId: string, amount: string, period = 'daily' as const) {
  await db.drizzle.db
    .insert(userLimit)
    .values({ userId, type: 'deposit', amount, minutes: null, period });
}

async function seedDeposit(userId: string, amount: string, createdAt = new Date()) {
  const [walletRow] = await db.drizzle.db
    .insert(wallet)
    .values({ userId, balance: '0', currency: 'USD' })
    .onConflictDoNothing()
    .returning();
  const [existing] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
  await db.drizzle.db.insert(walletTransaction).values({
    walletId: (walletRow ?? existing)!.id,
    type: 'deposit',
    amount,
    currency: 'USD',
    status: 'completed',
    createdAt,
  });
}

async function seedBet(userId: string, betAmount: string) {
  const [g] = await db.drizzle.db
    .insert(game)
    .values({ name: 'Slot', provider: 'mock', category: 'slots' })
    .returning();
  await db.drizzle.db
    .insert(gameRound)
    .values({ gameId: g!.id, userId, betAmount, currency: 'USD' });
}

async function seedSession(userId: string, startedMinutesAgo: number) {
  const [u] = await db.drizzle.db
    .insert(user)
    .values({ id: userId, name: 'P', email: `${userId}@test.dev`, emailVerified: true })
    .returning();
  await db.drizzle.db.insert(session).values({
    userId: u!.id,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(Date.now() - startedMinutesAgo * 60_000),
  });
}

const SESSION_DETAIL = { sessionMinutes: 55, limitMinutes: 60, pct: 92 };

async function flagsOf(userId: string) {
  return db.drizzle.db.select().from(rgFlag).where(eq(rgFlag.userId, userId));
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateWallet, migrateGaming, migrateIdentity]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${rgFlag}, ${rgExclusion}, ${userLimit}, ${walletTransaction}, ${wallet}, ${gameRound}, ${game}, ${session}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('RgMonitoringService.evaluateUser - deposit limits (real PG)', () => {
  it('raises a limit_threshold flag at exactly 80% of the limit', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const flags = await flagsOf(userId);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      flagType: 'limit_threshold',
      limitType: 'deposit',
      status: 'active',
    });
    expect(flags[0]?.detail).toMatchObject({ pct: 80, period: 'daily' });
  });

  it('stays quiet just below the threshold', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '79');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('clears an existing flag once spend drops back below the threshold', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');
    await makeService().evaluateUser(userId, 'wallet.deposit.completed');
    await db.drizzle.db.delete(walletTransaction);

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ status: 'cleared' });
    expect(flag?.clearedAt).toBeInstanceOf(Date);
  });

  it('updates the existing flag detail instead of raising a duplicate', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '80');
    await makeService().evaluateUser(userId, 'wallet.deposit.completed');
    await seedDeposit(userId, '20');

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    const flags = await flagsOf(userId);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.detail).toMatchObject({ pct: 100 });
  });

  it('ignores deposits made outside the limit period window', async () => {
    const userId = randomUUID();
    await seedDepositLimit(userId, '100');
    await seedDeposit(userId, '90', new Date(Date.now() - 48 * 3600_000));

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('skips the session limit on a deposit trigger', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(userLimit)
      .values({ userId, type: 'session', amount: null, minutes: 60, period: 'session' });

    await makeService().evaluateUser(userId, 'wallet.deposit.completed');

    expect(await flagsOf(userId)).toHaveLength(0);
  });
});

describe('RgMonitoringService.evaluateUser - wager limits (real PG)', () => {
  it('sums game rounds for a wager limit', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(userLimit)
      .values({ userId, type: 'wager', amount: '100', minutes: null, period: 'daily' });
    await seedBet(userId, '90');

    await makeService().evaluateUser(userId, 'gaming.round.ended');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'limit_threshold', limitType: 'wager' });
  });
});

describe('RgMonitoringService.evaluateUser - blocked login (real PG)', () => {
  it('labels the flag with self_exclusion when one is active', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgExclusion).values({
      userId,
      kind: 'self_exclusion',
      status: 'active',
      reason: 'stop',
      isPermanent: true,
      createdBy: randomUUID(),
    });

    await makeService().evaluateUser(userId, 'rg.exclusion.login_blocked');

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'self_excluded_login', limitType: null });
    expect(flag?.detail).toMatchObject({ kind: 'self_exclusion' });
  });

  it('labels the flag with cooling_off when that is the only active exclusion', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgExclusion).values({
      userId,
      kind: 'cooling_off',
      status: 'active',
      reason: 'break',
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: randomUUID(),
    });

    await makeService().evaluateUser(userId, 'rg.exclusion.login_blocked');

    const [flag] = await flagsOf(userId);
    expect(flag?.detail).toMatchObject({ kind: 'cooling_off' });
  });

  it('records a null kind when nothing is active any more', async () => {
    const userId = randomUUID();

    await makeService().evaluateUser(userId, 'rg.exclusion.login_blocked');

    const [flag] = await flagsOf(userId);
    expect(flag?.detail).toMatchObject({ kind: null });
  });
});

describe('RgMonitoringService.sweep (real PG)', () => {
  it('raises a session_time flag once the active session reaches the limit band', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(userLimit)
      .values({ userId, type: 'session', amount: null, minutes: 60, period: 'session' });
    await seedSession(userId, 50);

    await makeService().sweep();

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ flagType: 'session_time', status: 'active' });
  });

  it('leaves a short session unflagged', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(userLimit)
      .values({ userId, type: 'session', amount: null, minutes: 60, period: 'session' });
    await seedSession(userId, 10);

    await makeService().sweep();

    expect(await flagsOf(userId)).toHaveLength(0);
  });

  it('clears the flag once the session is gone', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(userLimit)
      .values({ userId, type: 'session', amount: null, minutes: 60, period: 'session' });
    await seedSession(userId, 50);
    await makeService().sweep();
    await db.drizzle.db.delete(session).where(eq(session.userId, userId));

    await makeService().sweep();

    const [flag] = await flagsOf(userId);
    expect(flag).toMatchObject({ status: 'cleared' });
  });
});

describe('RgMonitoringService.listFlags (real PG)', () => {
  it('filters by flag type and reports the unpaginated total', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgFlag).values([
      {
        userId,
        flagType: 'limit_threshold' as const,
        limitType: 'deposit',
        detail: SESSION_DETAIL,
      },
      { userId, flagType: 'session_time' as const, limitType: null, detail: SESSION_DETAIL },
    ]);

    const result = await makeService().listFlags({
      page: 1,
      limit: 10,
      flagType: 'limit_threshold',
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ flagType: 'limit_threshold', limitType: 'deposit' });
  });

  it('enriches rows with the player directory when one is bound', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(rgFlag)
      .values({ userId, flagType: 'session_time', limitType: null, detail: SESSION_DETAIL });
    const directory = mock<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((id) =>
          mock<AdminPlayerSummary>({ userId: id, username: 'player1', email: 'p@test.dev' }),
        ),
      ),
    });

    const result = await makeService(directory).listFlags({ page: 1, limit: 10 });

    expect(result.items[0]).toMatchObject({ username: 'player1', email: 'p@test.dev' });
  });

  it('leaves the identity fields null when no directory is bound', async () => {
    const userId = randomUUID();
    await db.drizzle.db
      .insert(rgFlag)
      .values({ userId, flagType: 'session_time', limitType: null, detail: SESSION_DETAIL });

    const result = await makeService().listFlags({ page: 1, limit: 10 });

    expect(result.items[0]).toMatchObject({ username: null, email: null });
  });

  it('pages the rows while the total covers the whole filtered set', async () => {
    const userId = randomUUID();
    await db.drizzle.db.insert(rgFlag).values([
      { userId, flagType: 'session_time' as const, limitType: null, detail: SESSION_DETAIL },
      { userId, flagType: 'self_excluded_login' as const, limitType: null, detail: SESSION_DETAIL },
      { userId, flagType: 'limit_threshold' as const, limitType: 'loss', detail: SESSION_DETAIL },
    ]);

    const result = await makeService().listFlags({ page: 2, limit: 2 });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
  });
});
