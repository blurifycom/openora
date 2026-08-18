import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { findOneOrThrow, RedisRateLimiter } from '@openora/core/server';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import type { PaymentAdapter, AuditWritePort } from '@openora/core/contracts';
import { mock, NO_CLIENT_META, makeEventBus, makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';

const events = makeEventBus();
const payment = mock<PaymentAdapter>({
  processDeposit: vi.fn(async () => ({ externalId: randomUUID(), status: 'completed' as const })),
});
const audit = mock<AuditWritePort>({ record: vi.fn() });

let db: TestDb;
let redis: TestRedis;

const makeService = () =>
  new WalletService({
    drizzle: db.drizzle,
    events,
    payment,
    audit,
    identityReader: makeIdentityReader(),
    limiter: new RedisRateLimiter(redis.client),
  });

async function seedWallet() {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), balance: '1000', currency: 'USD' })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: row.balance });
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('WalletService - rate limiting (real Redis + real PG)', () => {
  it('rejects a deposit with a 429 once the per-user mutation budget is exhausted', async () => {
    const w = await seedWallet();
    const svc = makeService();
    for (let i = 0; i < 30; i++) {
      await svc.deposit({ userId: w.userId, amount: '1', currency: 'USD' });
    }

    await expect(
      svc.deposit({ userId: w.userId, amount: '1', currency: 'USD' }),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: expect.any(Number) },
    });
    const rows = await db.drizzle.db.select().from(walletTransaction);
    expect(rows).toHaveLength(30);
  });

  it('counts deposits and withdrawals against the same per-user budget', async () => {
    const w = await seedWallet();
    const svc = makeService();
    for (let i = 0; i < 30; i++) {
      await svc.deposit({ userId: w.userId, amount: '1', currency: 'USD' });
    }

    await expect(
      svc.withdraw({ userId: w.userId, amount: '1', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('lets a withdraw through when the per-user budget is unused', async () => {
    const w = await seedWallet();
    const svc = makeService();

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '100',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('budgets each player separately', async () => {
    const exhausted = await seedWallet();
    const fresh = await seedWallet();
    const svc = makeService();
    for (let i = 0; i < 30; i++) {
      await svc.deposit({ userId: exhausted.userId, amount: '1', currency: 'USD' });
    }

    const result = await svc.deposit({ userId: fresh.userId, amount: '1', currency: 'USD' });

    expect(result.status).toBe('completed');
  });
});
