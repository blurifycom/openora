import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../testing/real-infra.js';
import { seedCompletedDeposit } from '../../../testing/seed-wallet.js';
import { WalletReaderService } from '@openora/core/wallet/seed';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { KycWithdrawalGate } from '../../adapters/kyc-withdrawal-gate.js';
import { migrate } from '../../migrate.js';
import { globalKycConfig } from '../../schema/index.js';

let testDb: TestDb;
let walletlessDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([migrate, migrateWallet]);
  walletlessDb = await createTestDb([migrate]);
}, 120_000);

beforeEach(async () => {
  await testDb.drizzle.db.delete(globalKycConfig);
});

afterAll(async () => {
  await testDb.drop();
  await walletlessDb.drop();
});

function gateOver(source: TestDb) {
  const reader = new WalletReaderService({ drizzle: source.drizzle, pivotCurrency: 'USD' });
  return new KycWithdrawalGate(testDb.drizzle, undefined, reader);
}

describe('withdrawal policy evaluation', () => {
  it('requires KYC when the pivot amount is unknown', async () => {
    const userId = randomUUID();
    await seedCompletedDeposit(testDb, userId, '1');

    const required = await gateOver(testDb).requiresKycForWithdrawal({
      userId,
      pivotAmount: null,
      pivotCurrency: 'USD',
    });

    expect(required).toBe(true);
  });

  it('uses the default threshold when no configuration row exists', async () => {
    const atThreshold = randomUUID();
    const aboveThreshold = randomUUID();
    await seedCompletedDeposit(testDb, atThreshold, '10000');
    await seedCompletedDeposit(testDb, aboveThreshold, '10000.01');
    const gate = gateOver(testDb);

    expect(
      await gate.requiresKycForWithdrawal({
        userId: atThreshold,
        pivotAmount: '5000000',
        pivotCurrency: 'USD',
      }),
    ).toBe(false);
    expect(
      await gate.requiresKycForWithdrawal({
        userId: aboveThreshold,
        pivotAmount: '5000000',
        pivotCurrency: 'USD',
      }),
    ).toBe(true);
  });

  it('rejects when the deposits read fails so the request is refused', async () => {
    await expect(
      gateOver(walletlessDb).requiresKycForWithdrawal({
        userId: randomUUID(),
        pivotAmount: '10',
        pivotCurrency: 'USD',
      }),
    ).rejects.toThrow();
  });
});
