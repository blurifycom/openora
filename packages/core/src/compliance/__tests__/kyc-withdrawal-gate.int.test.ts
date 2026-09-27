import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { findOneOrThrow, moneyScaleBy } from '@openora/core/server';
import type { ExchangeRateReader } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { mock } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { globalKycConfig } from '../schema/index.js';
import { KycWithdrawalGate } from '../adapters/kyc-withdrawal-gate.js';

let db: TestDb;

// BTC prices at 1000 USD; any other non-USD currency has no rate.
const rates = mock<ExchangeRateReader>({
  convert: vi.fn(async (amount: string, from: string, to: string) =>
    from === 'BTC' && to === 'USD' ? moneyScaleBy(amount, '1000') : null,
  ),
});

const gate = () => new KycWithdrawalGate(db.drizzle, rates);

async function setConfig(values: Partial<typeof globalKycConfig.$inferInsert>) {
  await db.drizzle.db.insert(globalKycConfig).values({ singletonKey: 'global', ...values });
}

async function seedPlayer(deposits: { amount: string; currency: string }[] = []) {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID() }).returning(),
    new Error('seedPlayer: no wallet row'),
  );
  for (const deposit of deposits) {
    await db.drizzle.db.insert(walletTransaction).values({
      walletId: row.id,
      type: 'deposit',
      status: 'completed',
      direction: 'credit',
      ...deposit,
    });
  }
  return row.userId;
}

const ask = (userId: string, pivotAmount: string | null) =>
  gate().requiresKycForWithdrawal({ userId, pivotAmount, pivotCurrency: 'USD' });

beforeAll(async () => {
  db = await createTestDb([migrate, migrateWallet]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${globalKycConfig}, ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('KycWithdrawalGate (real PG)', () => {
  it('never requires KYC while KYC is globally disabled, at any amount or when unpriced', async () => {
    await setConfig({ enabled: false, withdrawalThreshold: '100' });
    const userId = await seedPlayer([{ amount: '50000', currency: 'USD' }]);

    expect(await ask(userId, '1000000')).toBe(false);
    expect(await ask(userId, null)).toBe(false);
  });

  it('does not require KYC below both triggers', async () => {
    await setConfig({ enabled: true, withdrawalThreshold: '2000' });
    const userId = await seedPlayer([{ amount: '10000', currency: 'USD' }]);

    expect(await ask(userId, '2000')).toBe(false);
  });

  it('applies the defaults (enabled, 10000 cumulative, no withdrawal trigger) with no config row', async () => {
    const userId = await seedPlayer([{ amount: '9000', currency: 'USD' }]);

    expect(await ask(userId, '500000')).toBe(false);
  });

  it('requires KYC once cumulative completed deposits, priced into the pivot, exceed the threshold', async () => {
    await setConfig({ enabled: true });
    const userId = await seedPlayer([
      { amount: '9500', currency: 'USD' },
      { amount: '0.6', currency: 'BTC' },
    ]);

    expect(await ask(userId, '10')).toBe(true);
  });

  it('requires KYC for a withdrawal above the withdrawal threshold', async () => {
    await setConfig({ enabled: true, withdrawalThreshold: '2000' });
    const userId = await seedPlayer();

    expect(await ask(userId, '2000.01')).toBe(true);
  });

  it('fails closed when the withdrawal could not be priced', async () => {
    await setConfig({ enabled: true });
    const userId = await seedPlayer();

    expect(await ask(userId, null)).toBe(true);
  });

  it('fails closed when a deposit currency could not be priced', async () => {
    await setConfig({ enabled: true });
    const userId = await seedPlayer([{ amount: '1', currency: 'XYZ' }]);

    expect(await ask(userId, '10')).toBe(true);
  });
});
