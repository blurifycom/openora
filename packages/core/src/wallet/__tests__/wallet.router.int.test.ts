import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { queue, type PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, InProcessRealtimeTransport, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  testContext,
  makeAuditWriter,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletTransaction } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';

const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

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
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
  });
}

function routerWith(adminGuard: AdminGuard) {
  return createWalletRouter({
    wallet: realWalletService(),
    adminGuard,
    audit: makeAuditWriter(),
    paymentProviders: makePaymentProviderRegistry(),
    reconciliation: mock<ReconciliationService>({}),
    jobQueue: makeJobQueue(),
    reconciliationQueue: RECONCILIATION_QUEUE,
    realtime: new InProcessRealtimeTransport(),
  });
}

const transactionDenyingGuard = () =>
  makeAdminGuard({ deny: ['transaction'], caller: { userId: 'caller-1', role: 'support' } });

const allowingGuard = () => makeAdminGuard({ caller: { userId: 'caller-1' } });

const adjustmentDenyingGuard = () =>
  makeAdminGuard({
    deny: ['player:adjust-balance'],
    caller: { userId: 'caller-1', role: 'admin' },
  });

async function seedLedger(userId: string, amounts: string[]) {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId, currency: 'USD' }).returning(),
    new Error('seedLedger: query returned no row'),
  );
  for (const amount of amounts) {
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: row.id,
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
    expect(result.items.map((t) => t.amount).sort()).toEqual([
      '10.000000000000000000',
      '25.500000000000000000',
    ]);
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
    expect(result.items[0]?.amount).toBe('10.000000000000000000');
  });
});

describe('wallet router manualAdjustment authz', () => {
  it('requires the player:adjust-balance grant and changes nothing on denial', async () => {
    const userId = randomUUID();

    await expect(
      call(
        routerWith(adjustmentDenyingGuard()).manualAdjustment,
        {
          userId,
          direction: 'credit',
          amount: '5',
          currency: 'USD',
          reason: 'compensation',
          idempotencyKey: randomUUID(),
        },
        { context: CTX },
      ),
      // Asserted on the code, not just `ORPCError`: this input also fails
      // PlayerNotFoundError, so a bare instanceof check passes no matter which
      // permission the route asks for - and would not notice the guard changing.
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await db.drizzle.db.select().from(wallet)).toHaveLength(0);
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(0);
  });
});
