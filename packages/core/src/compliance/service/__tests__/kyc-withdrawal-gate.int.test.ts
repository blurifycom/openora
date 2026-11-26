import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletCurrencyTotal, WalletReader } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '../../../testing/real-infra.js';
import { KycWithdrawalGate } from '../../adapters/kyc-withdrawal-gate.js';
import { migrate } from '../../migrate.js';
import { globalKycConfig } from '../../schema/index.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb([migrate]);
}, 120_000);

beforeEach(async () => {
  await testDb.drizzle.db.delete(globalKycConfig);
});

afterAll(() => testDb.drop());

function walletReaderWith(deposits: () => Promise<WalletCurrencyTotal[]>) {
  const getDepositsByCurrency = vi.fn(deposits);
  const reader: Pick<WalletReader, 'getDepositsByCurrency'> = { getDepositsByCurrency };
  return { reader: reader as WalletReader, getDepositsByCurrency };
}

function gateWith(deposits: () => Promise<WalletCurrencyTotal[]>) {
  const wallet = walletReaderWith(deposits);
  return { gate: new KycWithdrawalGate(testDb.drizzle, undefined, wallet.reader), wallet };
}

describe('withdrawal policy evaluation', () => {
  it('requires KYC when the pivot amount is unknown', async () => {
    const { gate, wallet } = gateWith(async () => []);

    const required = await gate.requiresKycForWithdrawal({
      userId: randomUUID(),
      pivotAmount: null,
      pivotCurrency: 'USD',
    });

    expect(required).toBe(true);
    expect(wallet.getDepositsByCurrency).not.toHaveBeenCalled();
  });

  it('uses the default threshold when no configuration row exists', async () => {
    const userId = randomUUID();
    const atThreshold = gateWith(async () => [{ currency: 'USD', total: '10000' }]);
    const aboveThreshold = gateWith(async () => [{ currency: 'USD', total: '10000.01' }]);
    const input = { userId, pivotAmount: '5000000', pivotCurrency: 'USD' };

    expect(await atThreshold.gate.requiresKycForWithdrawal(input)).toBe(false);
    expect(await aboveThreshold.gate.requiresKycForWithdrawal(input)).toBe(true);
  });

  it('rejects when the deposits read fails so the request is refused', async () => {
    const { gate } = gateWith(async () => {
      throw new Error('wallet read unavailable');
    });

    await expect(
      gate.requiresKycForWithdrawal({
        userId: randomUUID(),
        pivotAmount: '10',
        pivotCurrency: 'USD',
      }),
    ).rejects.toThrow('wallet read unavailable');
  });
});
