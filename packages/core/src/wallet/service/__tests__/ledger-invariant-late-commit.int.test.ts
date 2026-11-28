import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { migrate as migrateServer } from '@openora/core/server/migrate';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
  mock,
} from '../../../testing/mock.js';
import { migrate } from '../../migrate.js';
import {
  wallet,
  walletBalance,
  walletReconciliationFinding,
  walletTransaction,
} from '../../schema/index.js';
import { ReconciliationService } from '../reconciliation.service.js';
import { WalletService } from '../wallet.service.js';

const NO_GRACE = 0;
const SEEDED_BALANCE = '10';
const LATE_DEPOSIT = '5';
const BALANCE_AFTER_LATE_DEPOSIT = '15';

let db: TestDb;
let lateWriter: Pool;

beforeAll(async () => {
  db = await createTestDb([migrateServer, migrate]);
  lateWriter = new Pool({ connectionString: db.url, max: 1 });
});

afterAll(async () => {
  await lateWriter.end();
  await db.drop();
});

function makeReconciliation() {
  const audit = makeAuditWriter();
  const paymentProviders = makePaymentProviderRegistry();
  const walletService = new WalletService({
    ...makeWithdrawalPorts(),
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock(),
    paymentProviders,
    audit,
    identityReader: makeIdentityReader(),
  });
  return new ReconciliationService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    wallet: walletService,
    paymentProviders,
    audit,
    ledgerBaselineGraceSeconds: NO_GRACE,
  });
}

async function seedWalletWithDeposit() {
  const [walletRow] = await db.drizzle.db
    .insert(wallet)
    .values({ userId: randomUUID(), currency: 'USD' })
    .returning();
  if (!walletRow) {
    throw new Error('seedWalletWithDeposit: no wallet row');
  }
  await db.drizzle.db.insert(walletTransaction).values({
    walletId: walletRow.id,
    type: 'deposit',
    amount: SEEDED_BALANCE,
    currency: 'USD',
    status: 'completed',
    balanceAfter: SEEDED_BALANCE,
  });
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: walletRow.id, currency: 'USD', amount: SEEDED_BALANCE });
  return walletRow;
}

describe('a wallet transaction that commits after the baseline moved past its start', () => {
  it('stays in the ledger the invariant checks', async () => {
    const reconciliation = makeReconciliation();
    const seeded = await seedWalletWithDeposit();

    const late = await lateWriter.connect();
    try {
      await late.query('BEGIN');
      await late.query(
        `INSERT INTO wallet_transaction (wallet_id, type, amount, currency, status, balance_after)
         VALUES ($1, 'deposit', $2, 'USD', 'completed', $3)`,
        [seeded.id, LATE_DEPOSIT, BALANCE_AFTER_LATE_DEPOSIT],
      );
      await late.query(
        `UPDATE wallet_balance SET amount = amount + $2 WHERE wallet_id = $1 AND currency = 'USD'`,
        [seeded.id, LATE_DEPOSIT],
      );

      await reconciliation.runLedgerInvariant();

      await late.query('COMMIT');
    } finally {
      late.release();
    }

    await reconciliation.runLedgerInvariant();

    const breaches = await db.drizzle.db
      .select({ detail: walletReconciliationFinding.detail })
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.kind, 'ledger_invariant_breach'));
    expect(breaches).toEqual([]);
  });
});
