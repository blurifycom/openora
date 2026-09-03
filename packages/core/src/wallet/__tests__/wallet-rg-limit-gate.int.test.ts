import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  RgLimitExceededError,
  type PaymentAdapter,
  type RgLimitsPort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeAuditWriter,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';

let db: TestDb;

const REFUSED = {
  allowed: false as const,
  limitType: 'deposit' as const,
  period: 'daily' as const,
  limit: '100',
  used: '90',
};

function makeService(rgLimits?: RgLimitsPort) {
  const payment = mock<PaymentAdapter>({
    processDeposit: vi.fn(async () => ({ externalId: `psp-${randomUUID()}`, status: 'completed' })),
  });
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment,
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    ...(rgLimits ? { rgLimits } : {}),
  });
  return { svc, payment };
}

const refusingGate = () =>
  mock<RgLimitsPort>({
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
      data: { limitType: 'deposit', period: 'daily', limit: '100', used: '90' },
    });
  });

  it('lets a deposit within the limit through', async () => {
    const { svc, payment } = makeService(
      mock<RgLimitsPort>({
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
