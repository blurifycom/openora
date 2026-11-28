import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { migrate as migrateServer } from '@openora/core/server/migrate';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makePaymentProviderRegistry,
  makeWithdrawalPorts,
  mock,
} from './mock.js';
import { migrate } from '../../migrate.js';
import {
  wallet,
  walletBalance,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
  type Wallet,
  type WalletJobRun,
} from '../../schema/index.js';
import { ReconciliationService } from '../reconciliation.service.js';
import { WalletService } from '../wallet.service.js';

const NO_GRACE = 0;
const SEEDED_BALANCE = '10';
const LATE_DEPOSIT = '5';
const BALANCE_AFTER_LATE_DEPOSIT = '15';

let db: TestDb;
let lateWriter: Pool;

beforeEach(async () => {
  db = await createTestDb([migrateServer, migrate]);
  lateWriter = new Pool({ connectionString: db.url, max: 1 });
});

afterEach(async () => {
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

async function writeLateDeposit(late: PoolClient, walletId: Wallet['id']) {
  await late.query(
    `INSERT INTO wallet_transaction (wallet_id, type, amount, currency, status, balance_after)
     VALUES ($1, 'deposit', $2, 'USD', 'completed', $3)`,
    [walletId, LATE_DEPOSIT, BALANCE_AFTER_LATE_DEPOSIT],
  );
  await late.query(
    `UPDATE wallet_balance SET amount = amount + $2 WHERE wallet_id = $1 AND currency = 'USD'`,
    [walletId, LATE_DEPOSIT],
  );
}

async function readBalance(late: PoolClient, walletId: Wallet['id']) {
  await late.query(`SELECT amount FROM wallet_balance WHERE wallet_id = $1`, [walletId]);
}

async function nothingYet() {}

async function runLedgerInvariant(reconciliation: ReconciliationService) {
  const run = await reconciliation.runLedgerInvariant();
  if (!run) {
    throw new Error('runLedgerInvariant: the run did not claim its slot');
  }
  return run.runId;
}

async function breaches() {
  return db.drizzle.db
    .select({ detail: walletReconciliationFinding.detail })
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.kind, 'ledger_invariant_breach'));
}

async function baselinesBeforeLateDeposit(runId: WalletJobRun['runId']) {
  const { rows } = await db.drizzle.db.execute<{ before_late: boolean }>(sql`
    select bl.as_of < t.created_at as before_late
    from wallet_balance_baseline bl
    join wallet_transaction t on t.wallet_id = bl.wallet_id and t.amount = ${LATE_DEPOSIT}
    where bl.run_id = ${runId}`);
  return rows.map((row) => row.before_late);
}

async function runSummary(runId: WalletJobRun['runId']) {
  const [run] = await db.drizzle.db
    .select({ summary: walletJobRun.summary })
    .from(walletJobRun)
    .where(eq(walletJobRun.runId, runId));
  return run?.summary;
}

describe('a wallet transaction that commits after the baseline moved past its start', () => {
  it.each([
    { when: 'writes before the run', beforeRun: writeLateDeposit, afterRun: nothingYet },
    {
      when: 'only reads before the run and writes after it',
      beforeRun: readBalance,
      afterRun: writeLateDeposit,
    },
  ])('stays in the ledger the invariant checks when it $when', async ({ beforeRun, afterRun }) => {
    const reconciliation = makeReconciliation();
    const seeded = await seedWalletWithDeposit();

    const late = await lateWriter.connect();
    let firstRun: WalletJobRun['runId'];
    try {
      await late.query('BEGIN');
      await beforeRun(late, seeded.id);

      firstRun = await runLedgerInvariant(reconciliation);

      await afterRun(late, seeded.id);
      await late.query('COMMIT');
    } finally {
      late.release();
    }

    const secondRun = await runLedgerInvariant(reconciliation);

    expect(await breaches()).toEqual([]);
    expect(await baselinesBeforeLateDeposit(firstRun)).toEqual([true]);
    expect(await runSummary(secondRun)).toMatchObject({ pairsChecked: 1, baselinesAdvanced: 1 });
  });
});
