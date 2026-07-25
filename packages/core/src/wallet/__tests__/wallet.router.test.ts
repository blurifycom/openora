import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { PaymentAdapter, PaymentWebhookVerifier } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

const CTX = testContext();
const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(walletTransaction);
  await db.drizzle.db.delete(wallet);
});

function realWalletService() {
  return new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({}),
    audit: makeAuditWriter(),
  });
}

function routerWith(adminGuard: AdminGuard) {
  return createWalletRouter(
    realWalletService(),
    adminGuard,
    makeAuditWriter(),
    mock<PaymentAdapter>({}),
    mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(false) }),
  );
}

const transactionDenyingGuard = () =>
  makeAdminGuard({ deny: ['transaction'], caller: { userId: 'caller-1', role: 'support' } });

const allowingGuard = () => makeAdminGuard({ caller: { userId: 'caller-1' } });

async function seedLedger(userId: string, amounts: string[]) {
  const [row] = await db.drizzle.db
    .insert(wallet)
    .values({ userId, balance: '0', currency: 'USD' })
    .returning();
  for (const amount of amounts) {
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: row!.id,
      type: 'deposit',
      amount,
      currency: 'USD',
      status: 'completed',
      rail: 'fiat',
    });
  }
}

describe('wallet router listPlayerTransactions authz', () => {
  it('rejects a caller lacking transaction:view (IDOR guard)', async () => {
    await seedLedger(USER_ID, ['10.00']);

    await expect(
      call(
        routerWith(transactionDenyingGuard()).listPlayerTransactions,
        { userId: USER_ID, page: 1, limit: 20 },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('allows a caller with transaction:view to read any player ledger', async () => {
    await seedLedger(USER_ID, ['10.00', '25.50']);

    const result = await call(
      routerWith(allowingGuard()).listPlayerTransactions,
      { userId: USER_ID, page: 1, limit: 20 },
      { context: CTX },
    );

    expect(result.total).toBe(2);
    expect(result.items.map((t) => t.amount).sort()).toEqual(['10.00000000', '25.50000000']);
  });

  it('reads only the requested player, never a neighbour ledger', async () => {
    await seedLedger(USER_ID, ['10.00']);
    await seedLedger(randomUUID(), ['999.00']);

    const result = await call(
      routerWith(allowingGuard()).listPlayerTransactions,
      { userId: USER_ID, page: 1, limit: 20 },
      { context: CTX },
    );

    expect(result.total).toBe(1);
    expect(result.items[0]?.amount).toBe('10.00000000');
  });
});
